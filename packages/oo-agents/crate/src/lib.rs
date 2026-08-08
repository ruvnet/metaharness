//! ooa-cell-vm — the code-as-action sandbox for @metaharness/oo-agents, a
//! Rust→wasm32 clone of NOOA's REPL cell executor (NVIDIA-NeMo/labs-OO-Agents,
//! `runtime/sandbox/cell_core.py`).
//!
//! The model acts by WRITING CODE. Each generation step emits one "cell" of
//! cellscript — a tiny, deterministic imperative language — which runs here
//! with REPL semantics faithful to NOOA's:
//!   - the cell's last expression (or an explicit `return`) is its value;
//!   - top-level bindings PERSIST into the namespace for later cells;
//!   - `return_result(v)` raises the ExecutionSignal that ends the agentic
//!     loop with a typed result;
//!   - `self.method(args)` / `self.field` bridge to the host agent object
//!     (capabilities and state) through a single JSON host import.
//!
//! Sandboxing is by construction, not by guard lists: the language has no
//! filesystem, no network, no clock, no randomness, and no FFI beyond the one
//! audited host call; wasm32 bounds memory; a FUEL budget bounds compute, so a
//! runaway cell traps deterministically instead of hanging the harness.

#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;

// ------------------------------------------------------------------ values --

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(BTreeMap<String, Value>),
}

impl Value {
    fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Num(n) => *n != 0.0,
            Value::Str(s) => !s.is_empty(),
            Value::Arr(a) => !a.is_empty(),
            Value::Obj(o) => !o.is_empty(),
        }
    }
    fn type_name(&self) -> &'static str {
        match self {
            Value::Null => "null",
            Value::Bool(_) => "bool",
            Value::Num(_) => "number",
            Value::Str(_) => "string",
            Value::Arr(_) => "array",
            Value::Obj(_) => "object",
        }
    }
}

// ------------------------------------------------------------------- json --

pub fn to_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Num(n) => {
            if n.is_finite() {
                if *n == n.trunc() && n.abs() < 1e15 {
                    out.push_str(&format!("{}", *n as i64));
                } else {
                    out.push_str(&format!("{n}"));
                }
            } else {
                out.push_str("null");
            }
        }
        Value::Str(s) => {
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        Value::Arr(a) => {
            out.push('[');
            for (i, e) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                to_json(e, out);
            }
            out.push(']');
        }
        Value::Obj(o) => {
            out.push('{');
            for (i, (k, e)) in o.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                to_json(&Value::Str(k.clone()), out);
                out.push(':');
                to_json(e, out);
            }
            out.push('}');
        }
    }
}

pub fn from_json(s: &str) -> Result<Value, String> {
    let b = s.as_bytes();
    let mut p = 0usize;
    let v = jval(b, &mut p)?;
    Ok(v)
}

fn jskip(b: &[u8], p: &mut usize) {
    while *p < b.len() && matches!(b[*p], b' ' | b'\t' | b'\n' | b'\r') {
        *p += 1;
    }
}

fn jval(b: &[u8], p: &mut usize) -> Result<Value, String> {
    jskip(b, p);
    match b.get(*p) {
        Some(b'n') => {
            *p += 4;
            Ok(Value::Null)
        }
        Some(b't') => {
            *p += 4;
            Ok(Value::Bool(true))
        }
        Some(b'f') => {
            *p += 5;
            Ok(Value::Bool(false))
        }
        Some(b'"') => {
            *p += 1;
            let mut s = String::new();
            while *p < b.len() {
                match b[*p] {
                    b'"' => {
                        *p += 1;
                        return Ok(Value::Str(s));
                    }
                    b'\\' => {
                        *p += 1;
                        match b.get(*p) {
                            Some(b'n') => s.push('\n'),
                            Some(b't') => s.push('\t'),
                            Some(b'r') => s.push('\r'),
                            Some(b'"') => s.push('"'),
                            Some(b'\\') => s.push('\\'),
                            Some(b'/') => s.push('/'),
                            Some(b'u') => {
                                let h = std::str::from_utf8(&b[*p + 1..*p + 5])
                                    .map_err(|_| "bad unicode escape")?;
                                let cp = u32::from_str_radix(h, 16).map_err(|_| "bad escape")?;
                                s.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                                *p += 4;
                            }
                            _ => return Err("bad escape".into()),
                        }
                        *p += 1;
                    }
                    c if c < 0x80 => {
                        s.push(c as char);
                        *p += 1;
                    }
                    _ => {
                        let start = *p;
                        let mut end = *p + 1;
                        while end < b.len() && (b[end] & 0xC0) == 0x80 {
                            end += 1;
                        }
                        s.push_str(std::str::from_utf8(&b[start..end]).map_err(|_| "bad utf8")?);
                        *p = end;
                    }
                }
            }
            Err("unterminated string".into())
        }
        Some(b'[') => {
            *p += 1;
            let mut a = Vec::new();
            jskip(b, p);
            if b.get(*p) == Some(&b']') {
                *p += 1;
                return Ok(Value::Arr(a));
            }
            loop {
                a.push(jval(b, p)?);
                jskip(b, p);
                match b.get(*p) {
                    Some(b',') => *p += 1,
                    Some(b']') => {
                        *p += 1;
                        return Ok(Value::Arr(a));
                    }
                    _ => return Err("bad array".into()),
                }
            }
        }
        Some(b'{') => {
            *p += 1;
            let mut o = BTreeMap::new();
            jskip(b, p);
            if b.get(*p) == Some(&b'}') {
                *p += 1;
                return Ok(Value::Obj(o));
            }
            loop {
                jskip(b, p);
                let k = match jval(b, p)? {
                    Value::Str(s) => s,
                    _ => return Err("object key must be string".into()),
                };
                jskip(b, p);
                if b.get(*p) != Some(&b':') {
                    return Err("expected ':'".into());
                }
                *p += 1;
                o.insert(k, jval(b, p)?);
                jskip(b, p);
                match b.get(*p) {
                    Some(b',') => *p += 1,
                    Some(b'}') => {
                        *p += 1;
                        return Ok(Value::Obj(o));
                    }
                    _ => return Err("bad object".into()),
                }
            }
        }
        _ => {
            let start = *p;
            while *p < b.len() && matches!(b[*p], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
                *p += 1;
            }
            std::str::from_utf8(&b[start..*p])
                .ok()
                .and_then(|s| s.parse::<f64>().ok())
                .map(Value::Num)
                .ok_or_else(|| "bad number".into())
        }
    }
}

// ------------------------------------------------------------------- lexer --

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Ident(String),
    Kw(&'static str),
    Op(&'static str),
    Eof,
}

const KEYWORDS: [&str; 10] = [
    "let", "if", "else", "while", "for", "in", "return", "true", "false", "null",
];

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let b = src.as_bytes();
    let mut p = 0usize;
    let mut out = Vec::new();
    while p < b.len() {
        let c = b[p];
        match c {
            b' ' | b'\t' | b'\r' | b'\n' => p += 1,
            b'#' => {
                while p < b.len() && b[p] != b'\n' {
                    p += 1;
                }
            }
            b'0'..=b'9' => {
                let start = p;
                while p < b.len() && matches!(b[p], b'0'..=b'9' | b'.') {
                    p += 1;
                }
                let s = std::str::from_utf8(&b[start..p]).unwrap();
                out.push(Tok::Num(s.parse().map_err(|_| format!("bad number {s}"))?));
            }
            b'"' => {
                p += 1;
                let mut s = String::new();
                loop {
                    if p >= b.len() {
                        return Err("unterminated string".into());
                    }
                    match b[p] {
                        b'"' => {
                            p += 1;
                            break;
                        }
                        b'\\' => {
                            p += 1;
                            match b.get(p) {
                                Some(b'n') => s.push('\n'),
                                Some(b't') => s.push('\t'),
                                Some(b'"') => s.push('"'),
                                Some(b'\\') => s.push('\\'),
                                _ => return Err("bad escape".into()),
                            }
                            p += 1;
                        }
                        c if c < 0x80 => {
                            s.push(c as char);
                            p += 1;
                        }
                        _ => {
                            let start = p;
                            let mut end = p + 1;
                            while end < b.len() && (b[end] & 0xC0) == 0x80 {
                                end += 1;
                            }
                            s.push_str(std::str::from_utf8(&b[start..end]).map_err(|_| "bad utf8")?);
                            p = end;
                        }
                    }
                }
                out.push(Tok::Str(s));
            }
            b'a'..=b'z' | b'A'..=b'Z' | b'_' => {
                let start = p;
                while p < b.len() && matches!(b[p], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_') {
                    p += 1;
                }
                let s = std::str::from_utf8(&b[start..p]).unwrap();
                match KEYWORDS.iter().find(|k| **k == s) {
                    Some(k) => out.push(Tok::Kw(k)),
                    None => out.push(Tok::Ident(s.to_string())),
                }
            }
            _ => {
                const TWO: [&str; 6] = ["==", "!=", "<=", ">=", "&&", "||"];
                let two = if p + 1 < b.len() {
                    std::str::from_utf8(&b[p..p + 2]).ok()
                } else {
                    None
                };
                if let Some(t) = two.and_then(|t| TWO.iter().find(|o| **o == t)) {
                    out.push(Tok::Op(t));
                    p += 2;
                    continue;
                }
                const ONE: [&str; 16] = [
                    "+", "-", "*", "/", "%", "<", ">", "!", "=", "(", ")", "[", "]", "{", "}", ",",
                ];
                let one = std::str::from_utf8(&b[p..p + 1]).unwrap();
                if let Some(t) = ONE.iter().find(|o| **o == one) {
                    out.push(Tok::Op(t));
                    p += 1;
                } else if c == b';' {
                    out.push(Tok::Op(";"));
                    p += 1;
                } else if c == b'.' {
                    out.push(Tok::Op("."));
                    p += 1;
                } else if c == b':' {
                    out.push(Tok::Op(":"));
                    p += 1;
                } else {
                    return Err(format!("unexpected character '{}'", c as char));
                }
            }
        }
    }
    out.push(Tok::Eof);
    Ok(out)
}

// ------------------------------------------------------------------ parser --

#[derive(Debug, Clone)]
enum Expr {
    Lit(Value),
    Var(String),
    Array(Vec<Expr>),
    Object(Vec<(String, Expr)>),
    Unary(&'static str, Box<Expr>),
    Bin(&'static str, Box<Expr>, Box<Expr>),
    Index(Box<Expr>, Box<Expr>),
    Member(Box<Expr>, String),
    Call(String, Vec<Expr>),
    SelfCall(String, Vec<Expr>),
    SelfField(String),
}

#[derive(Debug, Clone)]
enum Stmt {
    Let(String, Expr),
    Assign(String, Expr),
    IndexAssign(String, Expr, Expr),
    If(Expr, Vec<Stmt>, Vec<Stmt>),
    While(Expr, Vec<Stmt>),
    For(String, Expr, Vec<Stmt>),
    Return(Expr),
    Expr(Expr),
}

struct Parser {
    toks: Vec<Tok>,
    p: usize,
    /// Recursion-depth counter for the recursive-descent parser. Every nested
    /// expression (parentheses, array/object literals, call args) and every
    /// nested block increments it; exceeding MAX_PARSE_DEPTH returns a clean
    /// syntax error instead of overflowing the (small, ~1 MB) wasm stack. This
    /// is a HARD sandbox guarantee: adversarial input like `((((((…`, deeply
    /// nested arrays, or long `else if` chains must degrade to Outcome::Error,
    /// never to a Rust stack overflow / wasm trap.
    depth: u32,
}

/// Max nesting the parser (and, transitively, the tree-walking evaluator) will
/// descend before bailing. Kept well below the point where recursion would
/// exhaust the wasm linear-memory stack; real model-written cells nest only a
/// handful deep, so this never constrains legitimate code.
const MAX_PARSE_DEPTH: u32 = 128;

impl Parser {
    fn peek(&self) -> &Tok {
        &self.toks[self.p]
    }
    fn next(&mut self) -> Tok {
        let t = self.toks[self.p].clone();
        self.p += 1;
        t
    }
    fn eat_op(&mut self, op: &str) -> Result<(), String> {
        match self.next() {
            Tok::Op(o) if o == op => Ok(()),
            t => Err(format!("expected '{op}', got {t:?}")),
        }
    }
    fn try_op(&mut self, op: &str) -> bool {
        if matches!(self.peek(), Tok::Op(o) if *o == op) {
            self.p += 1;
            true
        } else {
            false
        }
    }

    fn block(&mut self) -> Result<Vec<Stmt>, String> {
        self.depth += 1;
        if self.depth > MAX_PARSE_DEPTH {
            return Err("block nesting too deep".into());
        }
        self.eat_op("{")?;
        let mut out = Vec::new();
        while !matches!(self.peek(), Tok::Op("}")) {
            out.push(self.stmt()?);
        }
        self.eat_op("}")?;
        // Only decremented on the success path; any error aborts the whole
        // parse (run_cell bails on the first Err), so the counter is never
        // reused after an error.
        self.depth -= 1;
        Ok(out)
    }

    fn stmt(&mut self) -> Result<Stmt, String> {
        let s = match self.peek().clone() {
            Tok::Kw("let") => {
                self.next();
                let name = match self.next() {
                    Tok::Ident(n) => n,
                    t => return Err(format!("expected name after let, got {t:?}")),
                };
                self.eat_op("=")?;
                Stmt::Let(name, self.expr()?)
            }
            Tok::Kw("if") => {
                self.next();
                self.eat_op("(")?;
                let c = self.expr()?;
                self.eat_op(")")?;
                let then = self.block()?;
                let els = if matches!(self.peek(), Tok::Kw("else")) {
                    self.next();
                    if matches!(self.peek(), Tok::Kw("if")) {
                        // `else if` recurses through stmt() (not block()), so it
                        // needs its own depth accounting or a long chain could
                        // overflow the stack independent of block nesting.
                        self.depth += 1;
                        if self.depth > MAX_PARSE_DEPTH {
                            return Err("statement nesting too deep".into());
                        }
                        let s = self.stmt()?;
                        self.depth -= 1;
                        vec![s]
                    } else {
                        self.block()?
                    }
                } else {
                    Vec::new()
                };
                return Ok(Stmt::If(c, then, els));
            }
            Tok::Kw("while") => {
                self.next();
                self.eat_op("(")?;
                let c = self.expr()?;
                self.eat_op(")")?;
                return Ok(Stmt::While(c, self.block()?));
            }
            Tok::Kw("for") => {
                self.next();
                self.eat_op("(")?;
                let name = match self.next() {
                    Tok::Ident(n) => n,
                    t => return Err(format!("expected loop variable, got {t:?}")),
                };
                match self.next() {
                    Tok::Kw("in") => {}
                    t => return Err(format!("expected 'in', got {t:?}")),
                }
                let it = self.expr()?;
                self.eat_op(")")?;
                return Ok(Stmt::For(name, it, self.block()?));
            }
            Tok::Kw("return") => {
                self.next();
                Stmt::Return(self.expr()?)
            }
            Tok::Ident(name) => {
                // lookahead for assignment forms
                let save = self.p;
                self.next();
                if self.try_op("=") {
                    Stmt::Assign(name, self.expr()?)
                } else if matches!(self.peek(), Tok::Op("[")) {
                    // maybe index assignment: name[expr] = expr
                    self.next();
                    let idx = self.expr()?;
                    self.eat_op("]")?;
                    if self.try_op("=") {
                        Stmt::IndexAssign(name, idx, self.expr()?)
                    } else {
                        self.p = save;
                        Stmt::Expr(self.expr()?)
                    }
                } else {
                    self.p = save;
                    Stmt::Expr(self.expr()?)
                }
            }
            _ => Stmt::Expr(self.expr()?),
        };
        self.try_op(";");
        Ok(s)
    }

    fn expr(&mut self) -> Result<Expr, String> {
        self.bin(0)
    }

    fn bin(&mut self, min: u8) -> Result<Expr, String> {
        // Every expression flows through bin(), and nested expressions
        // (parentheses, array/object/call arguments) re-enter it via
        // primary()->expr()->bin(). Counting here bounds the AST depth, which
        // in turn bounds the tree-walking evaluator's recursion at run time.
        self.depth += 1;
        if self.depth > MAX_PARSE_DEPTH {
            return Err("expression nesting too deep".into());
        }
        let mut lhs = self.unary()?;
        loop {
            let (op, prec) = match self.peek() {
                Tok::Op(o) => match *o {
                    "||" => ("||", 1),
                    "&&" => ("&&", 2),
                    "==" => ("==", 3),
                    "!=" => ("!=", 3),
                    "<" => ("<", 4),
                    "<=" => ("<=", 4),
                    ">" => (">", 4),
                    ">=" => (">=", 4),
                    "+" => ("+", 5),
                    "-" => ("-", 5),
                    "*" => ("*", 6),
                    "/" => ("/", 6),
                    "%" => ("%", 6),
                    _ => break,
                },
                _ => break,
            };
            if prec < min {
                break;
            }
            self.next();
            let rhs = self.bin(prec + 1)?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        self.depth -= 1;
        Ok(lhs)
    }

    fn unary(&mut self) -> Result<Expr, String> {
        if self.try_op("!") {
            return Ok(Expr::Unary("!", Box::new(self.unary()?)));
        }
        if self.try_op("-") {
            return Ok(Expr::Unary("-", Box::new(self.unary()?)));
        }
        self.postfix()
    }

    fn postfix(&mut self) -> Result<Expr, String> {
        let mut e = self.primary()?;
        loop {
            if self.try_op("[") {
                let idx = self.expr()?;
                self.eat_op("]")?;
                e = Expr::Index(Box::new(e), Box::new(idx));
            } else if self.try_op(".") {
                let name = match self.next() {
                    Tok::Ident(n) => n,
                    t => return Err(format!("expected member name, got {t:?}")),
                };
                // self.name(...) is a host capability call; self.name a state read
                if matches!(self.peek(), Tok::Op("(")) {
                    self.next();
                    let mut args = Vec::new();
                    if !self.try_op(")") {
                        loop {
                            args.push(self.expr()?);
                            if self.try_op(")") {
                                break;
                            }
                            self.eat_op(",")?;
                        }
                    }
                    match e {
                        Expr::Var(ref v) if v == "self" => e = Expr::SelfCall(name, args),
                        _ => return Err("method calls are only supported on self".into()),
                    }
                } else {
                    match e {
                        Expr::Var(ref v) if v == "self" => e = Expr::SelfField(name),
                        _ => e = Expr::Member(Box::new(e), name),
                    }
                }
            } else {
                break;
            }
        }
        Ok(e)
    }

    fn primary(&mut self) -> Result<Expr, String> {
        match self.next() {
            Tok::Num(n) => Ok(Expr::Lit(Value::Num(n))),
            Tok::Str(s) => Ok(Expr::Lit(Value::Str(s))),
            Tok::Kw("true") => Ok(Expr::Lit(Value::Bool(true))),
            Tok::Kw("false") => Ok(Expr::Lit(Value::Bool(false))),
            Tok::Kw("null") => Ok(Expr::Lit(Value::Null)),
            Tok::Ident(name) => {
                if matches!(self.peek(), Tok::Op("(")) {
                    self.next();
                    let mut args = Vec::new();
                    if !self.try_op(")") {
                        loop {
                            args.push(self.expr()?);
                            if self.try_op(")") {
                                break;
                            }
                            self.eat_op(",")?;
                        }
                    }
                    Ok(Expr::Call(name, args))
                } else {
                    Ok(Expr::Var(name))
                }
            }
            Tok::Op("(") => {
                let e = self.expr()?;
                self.eat_op(")")?;
                Ok(e)
            }
            Tok::Op("[") => {
                let mut items = Vec::new();
                if !self.try_op("]") {
                    loop {
                        items.push(self.expr()?);
                        if self.try_op("]") {
                            break;
                        }
                        self.eat_op(",")?;
                    }
                }
                Ok(Expr::Array(items))
            }
            Tok::Op("{") => {
                let mut fields = Vec::new();
                if !self.try_op("}") {
                    loop {
                        let key = match self.next() {
                            Tok::Ident(k) => k,
                            Tok::Str(k) => k,
                            t => return Err(format!("expected object key, got {t:?}")),
                        };
                        self.eat_op(":")?;
                        fields.push((key, self.expr()?));
                        if self.try_op("}") {
                            break;
                        }
                        self.eat_op(",")?;
                    }
                }
                Ok(Expr::Object(fields))
            }
            t => Err(format!("unexpected token {t:?}")),
        }
    }
}

// -------------------------------------------------------------- evaluation --

/// Why a cell stopped. Mirrors NOOA's ExecutionResult / ExecutionSignal split:
/// `Result` is the REPL value of the cell (last expression or `return`);
/// `Signal` is `return_result(v)` — the typed final answer that ends the loop.
pub enum Outcome {
    Result(Value),
    Signal(Value),
    Error(String),
}

enum Flow {
    Normal(Value),
    Return(Value),
    Signal(Value),
}

pub struct Vm {
    pub globals: BTreeMap<String, Value>,
    fuel: u64,
    pub prints: Vec<String>,
    host: fn(&str) -> String,
}

const DEFAULT_FUEL: u64 = 200_000;

impl Vm {
    pub fn new(host: fn(&str) -> String) -> Vm {
        Vm {
            globals: BTreeMap::new(),
            fuel: DEFAULT_FUEL,
            prints: Vec::new(),
            host,
        }
    }

    /// Run one cell with REPL semantics; namespace persists across calls.
    pub fn run_cell(&mut self, src: &str, fuel: u64) -> Outcome {
        self.fuel = if fuel == 0 { DEFAULT_FUEL } else { fuel };
        self.prints.clear();
        let toks = match lex(src) {
            Ok(t) => t,
            Err(e) => return Outcome::Error(format!("syntax error: {e}")),
        };
        let mut parser = Parser { toks, p: 0, depth: 0 };
        let mut stmts = Vec::new();
        while !matches!(parser.peek(), Tok::Eof) {
            match parser.stmt() {
                Ok(s) => stmts.push(s),
                Err(e) => return Outcome::Error(format!("syntax error: {e}")),
            }
        }
        let mut last = Value::Null;
        for s in &stmts {
            match self.exec(s) {
                Ok(Flow::Normal(v)) => last = v,
                Ok(Flow::Return(v)) => return Outcome::Result(v),
                Ok(Flow::Signal(v)) => return Outcome::Signal(v),
                Err(e) => return Outcome::Error(e),
            }
        }
        Outcome::Result(last)
    }

    fn burn(&mut self, n: u64) -> Result<(), String> {
        if self.fuel < n {
            return Err("fuel exhausted: cell exceeded its step budget".into());
        }
        self.fuel -= n;
        Ok(())
    }

    fn exec(&mut self, s: &Stmt) -> Result<Flow, String> {
        self.burn(1)?;
        match s {
            Stmt::Let(name, e) | Stmt::Assign(name, e) => {
                let v = self.eval(e)?;
                self.globals.insert(name.clone(), v);
                Ok(Flow::Normal(Value::Null))
            }
            Stmt::IndexAssign(name, idx, e) => {
                let iv = self.eval(idx)?;
                let v = self.eval(e)?;
                let target = self
                    .globals
                    .get_mut(name)
                    .ok_or_else(|| format!("unknown variable '{name}'"))?;
                match (target, iv) {
                    (Value::Arr(a), Value::Num(n)) => {
                        let i = n as usize;
                        if i >= a.len() {
                            return Err(format!("index {i} out of bounds (len {})", a.len()));
                        }
                        a[i] = v;
                    }
                    (Value::Obj(o), Value::Str(k)) => {
                        o.insert(k, v);
                    }
                    (t, i) => {
                        return Err(format!(
                            "cannot index {} with {}",
                            t.type_name(),
                            i.type_name()
                        ))
                    }
                }
                Ok(Flow::Normal(Value::Null))
            }
            Stmt::If(c, then, els) => {
                let cv = self.eval(c)?;
                let branch = if cv.truthy() { then } else { els };
                for s in branch {
                    match self.exec(s)? {
                        Flow::Normal(_) => {}
                        f => return Ok(f),
                    }
                }
                Ok(Flow::Normal(Value::Null))
            }
            Stmt::While(c, body) => {
                while self.eval(c)?.truthy() {
                    self.burn(1)?;
                    for s in body {
                        match self.exec(s)? {
                            Flow::Normal(_) => {}
                            f => return Ok(f),
                        }
                    }
                }
                Ok(Flow::Normal(Value::Null))
            }
            Stmt::For(name, it, body) => {
                let itv = self.eval(it)?;
                let items: Vec<Value> = match itv {
                    Value::Arr(a) => a,
                    Value::Obj(o) => o.keys().map(|k| Value::Str(k.clone())).collect(),
                    v => return Err(format!("cannot iterate {}", v.type_name())),
                };
                for item in items {
                    self.burn(1)?;
                    self.globals.insert(name.clone(), item);
                    for s in body {
                        match self.exec(s)? {
                            Flow::Normal(_) => {}
                            f => return Ok(f),
                        }
                    }
                }
                Ok(Flow::Normal(Value::Null))
            }
            Stmt::Return(e) => Ok(Flow::Return(self.eval(e)?)),
            Stmt::Expr(e) => Ok(Flow::Normal(self.eval(e)?)),
        }
    }

    fn eval(&mut self, e: &Expr) -> Result<Value, String> {
        self.burn(1)?;
        match e {
            Expr::Lit(v) => Ok(v.clone()),
            Expr::Var(name) => {
                if name == "self" {
                    return Err("'self' can only be used as self.field or self.method(...)".into());
                }
                self.globals
                    .get(name)
                    .cloned()
                    .ok_or_else(|| format!("unknown variable '{name}'"))
            }
            Expr::Array(items) => {
                let mut a = Vec::with_capacity(items.len());
                for i in items {
                    a.push(self.eval(i)?);
                }
                Ok(Value::Arr(a))
            }
            Expr::Object(fields) => {
                let mut o = BTreeMap::new();
                for (k, v) in fields {
                    o.insert(k.clone(), self.eval(v)?);
                }
                Ok(Value::Obj(o))
            }
            Expr::Unary(op, inner) => {
                let v = self.eval(inner)?;
                match (*op, v) {
                    ("!", v) => Ok(Value::Bool(!v.truthy())),
                    ("-", Value::Num(n)) => Ok(Value::Num(-n)),
                    ("-", v) => Err(format!("cannot negate {}", v.type_name())),
                    _ => unreachable!(),
                }
            }
            Expr::Bin(op, l, r) => {
                // short-circuit
                if *op == "&&" {
                    let lv = self.eval(l)?;
                    if !lv.truthy() {
                        return Ok(Value::Bool(false));
                    }
                    return Ok(Value::Bool(self.eval(r)?.truthy()));
                }
                if *op == "||" {
                    let lv = self.eval(l)?;
                    if lv.truthy() {
                        return Ok(Value::Bool(true));
                    }
                    return Ok(Value::Bool(self.eval(r)?.truthy()));
                }
                let lv = self.eval(l)?;
                let rv = self.eval(r)?;
                match (*op, &lv, &rv) {
                    ("+", Value::Num(a), Value::Num(b)) => Ok(Value::Num(a + b)),
                    ("+", Value::Str(a), b) => {
                        let mut s = a.clone();
                        s.push_str(&display(b));
                        Ok(Value::Str(s))
                    }
                    ("+", a, Value::Str(b)) => Ok(Value::Str(format!("{}{}", display(a), b))),
                    ("+", Value::Arr(a), Value::Arr(b)) => {
                        let mut out = a.clone();
                        out.extend(b.iter().cloned());
                        Ok(Value::Arr(out))
                    }
                    ("-", Value::Num(a), Value::Num(b)) => Ok(Value::Num(a - b)),
                    ("*", Value::Num(a), Value::Num(b)) => Ok(Value::Num(a * b)),
                    ("/", Value::Num(a), Value::Num(b)) => {
                        if *b == 0.0 {
                            Err("division by zero".into())
                        } else {
                            Ok(Value::Num(a / b))
                        }
                    }
                    ("%", Value::Num(a), Value::Num(b)) => {
                        if *b == 0.0 {
                            Err("modulo by zero".into())
                        } else {
                            Ok(Value::Num(a % b))
                        }
                    }
                    ("==", a, b) => Ok(Value::Bool(a == b)),
                    ("!=", a, b) => Ok(Value::Bool(a != b)),
                    ("<", Value::Num(a), Value::Num(b)) => Ok(Value::Bool(a < b)),
                    ("<=", Value::Num(a), Value::Num(b)) => Ok(Value::Bool(a <= b)),
                    (">", Value::Num(a), Value::Num(b)) => Ok(Value::Bool(a > b)),
                    (">=", Value::Num(a), Value::Num(b)) => Ok(Value::Bool(a >= b)),
                    ("<", Value::Str(a), Value::Str(b)) => Ok(Value::Bool(a < b)),
                    (">", Value::Str(a), Value::Str(b)) => Ok(Value::Bool(a > b)),
                    (op, a, b) => Err(format!(
                        "cannot apply '{op}' to {} and {}",
                        a.type_name(),
                        b.type_name()
                    )),
                }
            }
            Expr::Index(target, idx) => {
                let t = self.eval(target)?;
                let i = self.eval(idx)?;
                match (t, i) {
                    (Value::Arr(a), Value::Num(n)) => {
                        let i = n as usize;
                        a.get(i)
                            .cloned()
                            .ok_or_else(|| format!("index {i} out of bounds (len {})", a.len()))
                    }
                    (Value::Obj(o), Value::Str(k)) => Ok(o.get(&k).cloned().unwrap_or(Value::Null)),
                    (Value::Str(s), Value::Num(n)) => {
                        let i = n as usize;
                        s.chars()
                            .nth(i)
                            .map(|c| Value::Str(c.to_string()))
                            .ok_or_else(|| format!("index {i} out of bounds"))
                    }
                    (t, i) => Err(format!(
                        "cannot index {} with {}",
                        t.type_name(),
                        i.type_name()
                    )),
                }
            }
            Expr::Member(target, name) => {
                let t = self.eval(target)?;
                match t {
                    Value::Obj(o) => Ok(o.get(name).cloned().unwrap_or(Value::Null)),
                    v => Err(format!("no member '{name}' on {}", v.type_name())),
                }
            }
            Expr::SelfField(name) => {
                let mut req = String::new();
                to_json(
                    &Value::Obj(BTreeMap::from([(
                        "field".to_string(),
                        Value::Str(name.clone()),
                    )])),
                    &mut req,
                );
                self.host_roundtrip(&req)
            }
            Expr::SelfCall(name, args) => {
                self.burn(10)?; // host calls are the expensive action
                let mut av = Vec::with_capacity(args.len());
                for a in args {
                    av.push(self.eval(a)?);
                }
                let mut req = String::new();
                to_json(
                    &Value::Obj(BTreeMap::from([
                        ("method".to_string(), Value::Str(name.clone())),
                        ("args".to_string(), Value::Arr(av)),
                    ])),
                    &mut req,
                );
                self.host_roundtrip(&req)
            }
            Expr::Call(name, args) => {
                let mut av = Vec::with_capacity(args.len());
                for a in args {
                    av.push(self.eval(a)?);
                }
                self.builtin(name, av)
            }
        }
    }

    fn host_roundtrip(&mut self, req: &str) -> Result<Value, String> {
        let resp = (self.host)(req);
        let v = from_json(&resp).map_err(|e| format!("bad host response: {e}"))?;
        // Host responses are {"ok": value} or {"error": "message"} — a host
        // error becomes a cell error the model sees and can react to.
        if let Value::Obj(o) = &v {
            if let Some(e) = o.get("error") {
                return Err(format!("host error: {}", display(e)));
            }
            if let Some(ok) = o.get("ok") {
                return Ok(ok.clone());
            }
        }
        Err("host response must be {ok} or {error}".into())
    }

    fn builtin(&mut self, name: &str, mut args: Vec<Value>) -> Result<Value, String> {
        match name {
            "print" => {
                let line = args.iter().map(display).collect::<Vec<_>>().join(" ");
                self.prints.push(line);
                Ok(Value::Null)
            }
            "return_result" => {
                // Surfaced as the ExecutionSignal by run_cell's caller.
                Err(SIGNAL_MARKER.to_string()
                    + &{
                        let mut s = String::new();
                        to_json(args.first().unwrap_or(&Value::Null), &mut s);
                        s
                    })
            }
            "len" => match args.first() {
                Some(Value::Arr(a)) => Ok(Value::Num(a.len() as f64)),
                Some(Value::Str(s)) => Ok(Value::Num(s.chars().count() as f64)),
                Some(Value::Obj(o)) => Ok(Value::Num(o.len() as f64)),
                _ => Err("len() wants array, string, or object".into()),
            },
            "push" => {
                if args.len() != 2 {
                    return Err("push(array, value)".into());
                }
                let v = args.pop().unwrap();
                match args.pop().unwrap() {
                    Value::Arr(mut a) => {
                        a.push(v);
                        Ok(Value::Arr(a))
                    }
                    _ => Err("push() wants an array".into()),
                }
            }
            "keys" => match args.first() {
                Some(Value::Obj(o)) => {
                    Ok(Value::Arr(o.keys().map(|k| Value::Str(k.clone())).collect()))
                }
                _ => Err("keys() wants an object".into()),
            },
            "range" => match args.first() {
                Some(Value::Num(n)) => {
                    let n = (*n as i64).clamp(0, 1_000_000);
                    Ok(Value::Arr((0..n).map(|i| Value::Num(i as f64)).collect()))
                }
                _ => Err("range(n) wants a number".into()),
            },
            "str" => Ok(Value::Str(display(args.first().unwrap_or(&Value::Null)))),
            "num" => match args.first() {
                Some(Value::Num(n)) => Ok(Value::Num(*n)),
                Some(Value::Str(s)) => s
                    .trim()
                    .parse::<f64>()
                    .map(Value::Num)
                    .map_err(|_| format!("cannot parse '{s}' as a number")),
                Some(Value::Bool(b)) => Ok(Value::Num(if *b { 1.0 } else { 0.0 })),
                _ => Err("num() wants a number, string, or bool".into()),
            },

            // -- string ops -------------------------------------------------
            // All pure and first-order: no closures, no ambient authority, no
            // clock/randomness. Unicode case-folding and substring/splitting
            // are deterministic across platforms.
            "upper" => match args.first() {
                Some(Value::Str(s)) => Ok(Value::Str(s.to_uppercase())),
                _ => Err("upper(string) wants a string".into()),
            },
            "lower" => match args.first() {
                Some(Value::Str(s)) => Ok(Value::Str(s.to_lowercase())),
                _ => Err("lower(string) wants a string".into()),
            },
            "split" => match (args.first(), args.get(1)) {
                (Some(Value::Str(s)), Some(Value::Str(sep))) => {
                    // Empty separator splits into characters (matches how a
                    // model expects `split(word, "")` to enumerate letters).
                    let parts: Vec<Value> = if sep.is_empty() {
                        s.chars().map(|c| Value::Str(c.to_string())).collect()
                    } else {
                        s.split(sep.as_str())
                            .map(|p| Value::Str(p.to_string()))
                            .collect()
                    };
                    Ok(Value::Arr(parts))
                }
                _ => Err("split(string, separator) wants two strings".into()),
            },
            "join" => match (args.first(), args.get(1)) {
                (Some(Value::Arr(a)), Some(Value::Str(sep))) => {
                    let parts: Vec<String> = a.iter().map(display).collect();
                    Ok(Value::Str(parts.join(sep)))
                }
                _ => Err("join(array, separator) wants an array and a string".into()),
            },

            // -- number ops -------------------------------------------------
            "abs" => match args.first() {
                Some(Value::Num(n)) => Ok(Value::Num(n.abs())),
                _ => Err("abs(number) wants a number".into()),
            },
            "floor" => match args.first() {
                Some(Value::Num(n)) => Ok(Value::Num(n.floor())),
                _ => Err("floor(number) wants a number".into()),
            },
            // min/max accept either a single array argument or a variadic list
            // of numbers, whichever the model reaches for. NaN never wins a
            // comparison (`<`/`>` are false against NaN), so the fold is
            // deterministic even for pathological inputs like inf-inf.
            "min" | "max" => {
                let want_max = name == "max";
                let nums: Vec<f64> = match (args.len(), args.first()) {
                    (1, Some(Value::Arr(a))) => {
                        let mut v = Vec::with_capacity(a.len());
                        for e in a {
                            match e {
                                Value::Num(n) => v.push(*n),
                                o => {
                                    return Err(format!(
                                        "{name}() wants numbers, got {}",
                                        o.type_name()
                                    ))
                                }
                            }
                        }
                        v
                    }
                    _ => {
                        let mut v = Vec::with_capacity(args.len());
                        for a in &args {
                            match a {
                                Value::Num(n) => v.push(*n),
                                o => {
                                    return Err(format!(
                                        "{name}() wants numbers, got {}",
                                        o.type_name()
                                    ))
                                }
                            }
                        }
                        v
                    }
                };
                match nums.split_first() {
                    None => Err(format!("{name}() of an empty set")),
                    Some((&first, rest)) => {
                        let mut acc = first;
                        for &n in rest {
                            if want_max {
                                if n > acc {
                                    acc = n;
                                }
                            } else if n < acc {
                                acc = n;
                            }
                        }
                        Ok(Value::Num(acc))
                    }
                }
            }

            // -- array / membership ops ------------------------------------
            // Deterministic sort of a homogeneous array. Numbers use total
            // ordering (total_cmp gives NaN a fixed, well-defined place so the
            // output never depends on input order); strings use lexicographic
            // Unicode-scalar ordering. Mixed arrays are a clean error rather
            // than an arbitrary cross-type comparison.
            "sort" => match args.first() {
                Some(Value::Arr(a)) => {
                    if a.is_empty() {
                        return Ok(Value::Arr(Vec::new()));
                    }
                    // O(n log n); charge fuel proportional to length so a huge
                    // array can't buy unbounded compute for a single step.
                    self.burn(a.len() as u64)?;
                    if a.iter().all(|v| matches!(v, Value::Num(_))) {
                        let mut nums: Vec<f64> = a
                            .iter()
                            .map(|v| match v {
                                Value::Num(n) => *n,
                                _ => 0.0,
                            })
                            .collect();
                        nums.sort_by(|x, y| x.total_cmp(y));
                        Ok(Value::Arr(nums.into_iter().map(Value::Num).collect()))
                    } else if a.iter().all(|v| matches!(v, Value::Str(_))) {
                        let mut ss: Vec<String> = a
                            .iter()
                            .map(|v| match v {
                                Value::Str(s) => s.clone(),
                                _ => String::new(),
                            })
                            .collect();
                        ss.sort();
                        Ok(Value::Arr(ss.into_iter().map(Value::Str).collect()))
                    } else {
                        Err("sort() wants a homogeneous array of numbers or strings".into())
                    }
                }
                _ => Err("sort(array) wants an array".into()),
            },
            // contains(seq, item): substring for strings, element membership
            // for arrays, key presence for objects.
            "contains" => match (args.first(), args.get(1)) {
                (Some(Value::Str(h)), Some(Value::Str(n))) => {
                    Ok(Value::Bool(h.contains(n.as_str())))
                }
                (Some(Value::Arr(a)), Some(item)) => Ok(Value::Bool(a.iter().any(|e| e == item))),
                (Some(Value::Obj(o)), Some(Value::Str(k))) => Ok(Value::Bool(o.contains_key(k))),
                _ => Err("contains(string|array|object, item) got wrong types".into()),
            },
            // slice(seq, start[, end]): Python-style, with negative indices
            // counting from the end and out-of-range bounds clamped (never a
            // panic). Works on strings (by character) and arrays.
            "slice" => {
                let seq = args.first().ok_or("slice(seq, start[, end]) needs a sequence")?;
                let len = match seq {
                    Value::Str(s) => s.chars().count(),
                    Value::Arr(a) => a.len(),
                    o => return Err(format!("slice() wants a string or array, got {}", o.type_name())),
                };
                let start = match args.get(1) {
                    Some(Value::Num(n)) => clamp_index(*n, len),
                    _ => return Err("slice(seq, start[, end]) start must be a number".into()),
                };
                let end = match args.get(2) {
                    None | Some(Value::Null) => len,
                    Some(Value::Num(n)) => clamp_index(*n, len),
                    Some(o) => {
                        return Err(format!("slice() end must be a number, got {}", o.type_name()))
                    }
                };
                let end = end.max(start);
                match seq {
                    Value::Str(s) => {
                        Ok(Value::Str(s.chars().skip(start).take(end - start).collect()))
                    }
                    Value::Arr(a) => Ok(Value::Arr(a[start..end].to_vec())),
                    _ => unreachable!(),
                }
            }
            // get(container, key[, default]): safe indexing that returns a
            // default (null if omitted) instead of erroring on a miss —
            // works on objects (string key) and arrays (numeric index).
            "get" => {
                if !(2..=3).contains(&args.len()) {
                    return Err("get(container, key[, default])".into());
                }
                let default = args.get(2).cloned().unwrap_or(Value::Null);
                match (args.first(), args.get(1)) {
                    (Some(Value::Obj(o)), Some(Value::Str(k))) => {
                        Ok(o.get(k).cloned().unwrap_or(default))
                    }
                    (Some(Value::Arr(a)), Some(Value::Num(n))) => {
                        if *n < 0.0 || n.fract() != 0.0 {
                            Ok(default)
                        } else {
                            Ok(a.get(*n as usize).cloned().unwrap_or(default))
                        }
                    }
                    _ => Err("get() wants (object, string) or (array, number)".into()),
                }
            }

            _ => Err(format!("unknown function '{name}'")),
        }
    }
}

/// The `return_result` signal travels through the error channel with this
/// marker so it unwinds every enclosing block immediately — same effect as
/// NOOA's ExecutionSignal exception.
const SIGNAL_MARKER: &str = "\u{1}SIGNAL\u{1}";

/// Resolve a (possibly negative or out-of-range) slice index into a clamped
/// `[0, len]` bound. Negative counts from the end (Python semantics); NaN and
/// wildly out-of-range floats saturate rather than panic — Rust's float→int
/// cast already saturates, and we clamp again for the negative-wrap case.
fn clamp_index(n: f64, len: usize) -> usize {
    if n.is_nan() {
        return 0;
    }
    let i = n.trunc() as i64;
    let i = if i < 0 { i.saturating_add(len as i64) } else { i };
    i.clamp(0, len as i64) as usize
}

fn display(v: &Value) -> String {
    match v {
        Value::Str(s) => s.clone(),
        other => {
            let mut s = String::new();
            to_json(other, &mut s);
            s
        }
    }
}

// -------------------------------------------------------------- wasm bridge --

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;

    extern "C" {
        /// Host agent bridge: request JSON in, response JSON out (see
        /// host_roundtrip for the {ok}/{error} contract). The host writes the
        /// response through `ooa_alloc` and returns the packed ptr.
        fn ooa_host_call(ptr: *const u8, len: usize) -> *mut u8;
    }

    static mut VM: Option<Vm> = None;

    fn host_shim(req: &str) -> String {
        unsafe {
            let ptr = ooa_host_call(req.as_ptr(), req.len());
            let len = u32::from_le_bytes(std::slice::from_raw_parts(ptr, 4).try_into().unwrap())
                as usize;
            let bytes = std::slice::from_raw_parts(ptr.add(4), len);
            String::from_utf8_lossy(bytes).into_owned()
        }
    }

    /// Allocate `n` bytes the host can write into (leaked; cells are short).
    #[no_mangle]
    pub extern "C" fn ooa_alloc(n: usize) -> *mut u8 {
        let mut v = Vec::<u8>::with_capacity(n);
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    /// Reset the REPL namespace (a fresh agentic method call).
    #[no_mangle]
    pub extern "C" fn ooa_reset() {
        unsafe { VM = Some(Vm::new(host_shim)) }
    }

    /// Run one cell; returns a packed [u32 len][json bytes] pointer with
    /// {"kind":"result"|"signal"|"error", "value"|"message", "prints":[...]}.
    #[no_mangle]
    pub extern "C" fn ooa_run_cell(ptr: *const u8, len: usize, fuel: u64) -> *mut u8 {
        let src = unsafe {
            std::str::from_utf8_unchecked(std::slice::from_raw_parts(ptr, len)).to_string()
        };
        let vm = unsafe {
            if VM.is_none() {
                VM = Some(Vm::new(host_shim));
            }
            VM.as_mut().unwrap()
        };
        let outcome = vm.run_cell_outcome(&src, fuel);
        let mut o = BTreeMap::new();
        match outcome {
            Outcome::Result(v) => {
                o.insert("kind".into(), Value::Str("result".into()));
                o.insert("value".into(), v);
            }
            Outcome::Signal(v) => {
                o.insert("kind".into(), Value::Str("signal".into()));
                o.insert("value".into(), v);
            }
            Outcome::Error(e) => {
                o.insert("kind".into(), Value::Str("error".into()));
                o.insert("message".into(), Value::Str(e));
            }
        }
        o.insert(
            "prints".into(),
            Value::Arr(vm.prints.iter().cloned().map(Value::Str).collect()),
        );
        let mut json = String::new();
        to_json(&Value::Obj(o), &mut json);
        let bytes = json.as_bytes();
        let out = ooa_alloc(4 + bytes.len());
        unsafe {
            out.copy_from(
                (bytes.len() as u32).to_le_bytes().as_ptr(),
                4,
            );
            out.add(4).copy_from(bytes.as_ptr(), bytes.len());
        }
        out
    }
}

// run_cell surfaces return_result via the error channel; translate here so
// native (test) and wasm callers both see Outcome::Signal.
impl Vm {
    pub fn run_cell_outcome(&mut self, src: &str, fuel: u64) -> Outcome {
        match self.run_cell(src, fuel) {
            Outcome::Error(e) if e.starts_with(SIGNAL_MARKER) => {
                let json = &e[SIGNAL_MARKER.len()..];
                match from_json(json) {
                    Ok(v) => Outcome::Signal(v),
                    Err(err) => Outcome::Error(format!("bad signal payload: {err}")),
                }
            }
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(req: &str) -> String {
        // test double: {"field":"orders"} -> 3; {"method":"add","args":[a,b]} -> a+b
        if req.contains("\"field\"") {
            "{\"ok\":3}".to_string()
        } else if req.contains("\"add\"") {
            let v = from_json(req).unwrap();
            if let Value::Obj(o) = v {
                if let Some(Value::Arr(a)) = o.get("args") {
                    if let (Value::Num(x), Value::Num(y)) = (&a[0], &a[1]) {
                        return format!("{{\"ok\":{}}}", x + y);
                    }
                }
            }
            "{\"error\":\"bad args\"}".to_string()
        } else {
            "{\"error\":\"unknown\"}".to_string()
        }
    }

    fn run(vm: &mut Vm, src: &str) -> Outcome {
        vm.run_cell_outcome(src, 0)
    }

    #[test]
    fn repl_last_expression_and_persistence() {
        let mut vm = Vm::new(host);
        match run(&mut vm, "let x = 2 + 3\nx * 10") {
            Outcome::Result(Value::Num(n)) => assert_eq!(n, 50.0),
            o => panic!("{:?}", outcome_dbg(o)),
        }
        // x persists into the next cell — REPL semantics
        match run(&mut vm, "x + 1") {
            Outcome::Result(Value::Num(n)) => assert_eq!(n, 6.0),
            o => panic!("{:?}", outcome_dbg(o)),
        }
    }

    #[test]
    fn control_flow_and_builtins() {
        let mut vm = Vm::new(host);
        let src = r#"
            let total = 0
            for (i in range(5)) { total = total + i }
            let out = []
            if (total >= 10) { out = push(out, "big") } else { out = push(out, "small") }
            out[0] + ":" + str(total)
        "#;
        match run(&mut vm, src) {
            Outcome::Result(Value::Str(s)) => assert_eq!(s, "big:10"),
            o => panic!("{:?}", outcome_dbg(o)),
        }
    }

    #[test]
    fn self_bridge_and_signal() {
        let mut vm = Vm::new(host);
        match run(&mut vm, "let n = self.orders\nself.add(n, 4)") {
            Outcome::Result(Value::Num(n)) => assert_eq!(n, 7.0),
            o => panic!("{:?}", outcome_dbg(o)),
        }
        match run(&mut vm, "return_result({answer: self.add(1, 2)})") {
            Outcome::Signal(Value::Obj(o)) => assert_eq!(o.get("answer"), Some(&Value::Num(3.0))),
            o => panic!("{:?}", outcome_dbg(o)),
        }
    }

    #[test]
    fn fuel_traps_runaway_cells() {
        let mut vm = Vm::new(host);
        match vm.run_cell_outcome("let i = 0\nwhile (true) { i = i + 1 }", 5_000) {
            Outcome::Error(e) => assert!(e.contains("fuel exhausted"), "{e}"),
            o => panic!("{:?}", outcome_dbg(o)),
        }
    }

    #[test]
    fn signal_unwinds_from_inside_loops() {
        let mut vm = Vm::new(host);
        let src = "for (i in range(100)) { if (i == 3) { return_result(i) } }";
        match run(&mut vm, src) {
            Outcome::Signal(Value::Num(n)) => assert_eq!(n, 3.0),
            o => panic!("{:?}", outcome_dbg(o)),
        }
    }

    // Expect a Result-outcome and hand back its Value; panics with context
    // otherwise so a regression points at the offending case.
    fn result_of(o: Outcome) -> Value {
        match o {
            Outcome::Result(v) => v,
            other => panic!("expected Result, got {}", outcome_dbg(other)),
        }
    }

    fn err_of(o: Outcome) -> String {
        match o {
            Outcome::Error(e) => e,
            other => panic!("expected Error, got {}", outcome_dbg(other)),
        }
    }

    // ---- new builtins: string ops --------------------------------------

    #[test]
    fn str_upper_lower() {
        let mut vm = Vm::new(host);
        assert_eq!(result_of(run(&mut vm, r#"upper("aBc")"#)), Value::Str("ABC".into()));
        assert_eq!(result_of(run(&mut vm, r#"lower("aBc")"#)), Value::Str("abc".into()));
        assert!(err_of(run(&mut vm, "upper(5)")).contains("wants a string"));
    }

    #[test]
    fn str_split_and_join() {
        let mut vm = Vm::new(host);
        assert_eq!(
            result_of(run(&mut vm, r#"split("a,b,c", ",")"#)),
            Value::Arr(vec![
                Value::Str("a".into()),
                Value::Str("b".into()),
                Value::Str("c".into())
            ])
        );
        // empty separator -> characters
        assert_eq!(
            result_of(run(&mut vm, r#"split("hi", "")"#)),
            Value::Arr(vec![Value::Str("h".into()), Value::Str("i".into())])
        );
        assert_eq!(
            result_of(run(&mut vm, r#"join(["a", "b", "c"], "-")"#)),
            Value::Str("a-b-c".into())
        );
        // join stringifies non-string elements deterministically
        assert_eq!(
            result_of(run(&mut vm, r#"join([1, 2, 3], ",")"#)),
            Value::Str("1,2,3".into())
        );
    }

    #[test]
    fn str_contains() {
        let mut vm = Vm::new(host);
        assert_eq!(result_of(run(&mut vm, r#"contains("hello", "ell")"#)), Value::Bool(true));
        assert_eq!(result_of(run(&mut vm, r#"contains("hello", "xyz")"#)), Value::Bool(false));
    }

    // ---- new builtins: number ops --------------------------------------

    #[test]
    fn num_min_max_abs_floor() {
        let mut vm = Vm::new(host);
        assert_eq!(result_of(run(&mut vm, "min(3, 1, 2)")), Value::Num(1.0));
        assert_eq!(result_of(run(&mut vm, "max(3, 1, 2)")), Value::Num(3.0));
        assert_eq!(result_of(run(&mut vm, "min([5, 2, 9])")), Value::Num(2.0));
        assert_eq!(result_of(run(&mut vm, "max([5, 2, 9])")), Value::Num(9.0));
        assert_eq!(result_of(run(&mut vm, "abs(-4)")), Value::Num(4.0));
        assert_eq!(result_of(run(&mut vm, "floor(3.9)")), Value::Num(3.0));
        assert_eq!(result_of(run(&mut vm, "floor(-0.1)")), Value::Num(-1.0));
        assert!(err_of(run(&mut vm, "min()")).contains("empty set"));
        assert!(err_of(run(&mut vm, r#"max(1, "x")"#)).contains("wants numbers"));
    }

    // ---- new builtins: array / object ops ------------------------------

    #[test]
    fn arr_sort_numbers_and_strings() {
        let mut vm = Vm::new(host);
        assert_eq!(
            result_of(run(&mut vm, "sort([3, 1, 2, 1])")),
            Value::Arr(vec![
                Value::Num(1.0),
                Value::Num(1.0),
                Value::Num(2.0),
                Value::Num(3.0)
            ])
        );
        assert_eq!(
            result_of(run(&mut vm, r#"sort(["banana", "apple", "cherry"])"#)),
            Value::Arr(vec![
                Value::Str("apple".into()),
                Value::Str("banana".into()),
                Value::Str("cherry".into())
            ])
        );
        assert_eq!(result_of(run(&mut vm, "sort([])")), Value::Arr(vec![]));
        // mixed arrays are a clean error, not an arbitrary ordering
        assert!(err_of(run(&mut vm, r#"sort([1, "a"])"#)).contains("homogeneous"));
    }

    #[test]
    fn arr_contains_membership() {
        let mut vm = Vm::new(host);
        assert_eq!(result_of(run(&mut vm, "contains([1, 2, 3], 2)")), Value::Bool(true));
        assert_eq!(result_of(run(&mut vm, "contains([1, 2, 3], 9)")), Value::Bool(false));
        assert_eq!(
            result_of(run(&mut vm, r#"contains({a: 1, b: 2}, "a")"#)),
            Value::Bool(true)
        );
    }

    #[test]
    fn seq_slice() {
        let mut vm = Vm::new(host);
        assert_eq!(
            result_of(run(&mut vm, "slice([1, 2, 3, 4, 5], 1, 3)")),
            Value::Arr(vec![Value::Num(2.0), Value::Num(3.0)])
        );
        assert_eq!(result_of(run(&mut vm, r#"slice("hello", 1, 4)"#)), Value::Str("ell".into()));
        // omitted end -> to the tail
        assert_eq!(result_of(run(&mut vm, r#"slice("hello", 2)"#)), Value::Str("llo".into()));
        // negative index counts from the end
        assert_eq!(result_of(run(&mut vm, r#"slice("hello", -2)"#)), Value::Str("lo".into()));
        // out-of-range bounds clamp, never panic
        assert_eq!(result_of(run(&mut vm, r#"slice("hi", 5, 99)"#)), Value::Str("".into()));
    }

    #[test]
    fn obj_get_with_default() {
        let mut vm = Vm::new(host);
        assert_eq!(result_of(run(&mut vm, r#"get({a: 1}, "a", 0)"#)), Value::Num(1.0));
        assert_eq!(result_of(run(&mut vm, r#"get({a: 1}, "b", 42)"#)), Value::Num(42.0));
        // default omitted -> null
        assert_eq!(result_of(run(&mut vm, r#"get({a: 1}, "z")"#)), Value::Null);
        // array form with numeric index
        assert_eq!(result_of(run(&mut vm, "get([10, 20], 1, -1)")), Value::Num(20.0));
        assert_eq!(result_of(run(&mut vm, "get([10, 20], 9, -1)")), Value::Num(-1.0));
    }

    // ---- robustness: adversarial input is a clean Error, never a crash -

    #[test]
    fn deep_nesting_is_a_clean_error_not_a_stack_overflow() {
        let mut vm = Vm::new(host);
        // thousands of open parens would overflow a naive recursive-descent
        // parser; the depth guard turns it into an Outcome::Error instead.
        let src = "(".repeat(5000);
        let e = err_of(run(&mut vm, &src));
        assert!(e.contains("too deep") || e.contains("syntax"), "{e}");
        // deeply nested arrays likewise
        let arr = format!("{}{}", "[".repeat(4000), "]".repeat(4000));
        match run(&mut vm, &arr) {
            Outcome::Error(_) => {}
            o => panic!("expected Error, got {}", outcome_dbg(o)),
        }
    }

    #[test]
    fn huge_literals_do_not_panic() {
        let mut vm = Vm::new(host);
        // a 400-digit integer literal overflows f64 to +inf; must round-trip
        // (serialize as null) without UB. The lexer has no exponent syntax, so
        // a long digit run is the way to reach non-finite territory.
        let overflow = "9".repeat(400);
        match run(&mut vm, &overflow) {
            Outcome::Result(Value::Num(n)) => assert!(n.is_infinite()),
            o => panic!("expected numeric Result, got {}", outcome_dbg(o)),
        }
        // a large-but-finite literal parses to the nearest f64, no panic
        match run(&mut vm, "99999999999999999999999999999999999999") {
            Outcome::Result(Value::Num(n)) => assert!(n.is_finite()),
            o => panic!("expected numeric Result, got {}", outcome_dbg(o)),
        }
        // print path exercises to_json on a non-finite number (emits null)
        let src = format!("print({overflow})\n1");
        assert!(matches!(run(&mut vm, &src), Outcome::Result(_)));
    }

    #[test]
    fn malformed_but_lexable_input_is_a_syntax_error() {
        let mut vm = Vm::new(host);
        for src in ["let = = ] )", "if while for", "1 + + + 2", "] [ } {", ", , ,", "+ * /"] {
            match run(&mut vm, src) {
                Outcome::Error(_) => {}
                o => panic!("`{src}` expected Error, got {}", outcome_dbg(o)),
            }
        }
    }

    #[test]
    fn arithmetic_edge_cases_are_errors_not_traps() {
        let mut vm = Vm::new(host);
        assert!(err_of(run(&mut vm, "1 / 0")).contains("division by zero"));
        assert!(err_of(run(&mut vm, "5 % 0")).contains("modulo by zero"));
    }

    #[test]
    fn out_of_bounds_index_is_an_error() {
        let mut vm = Vm::new(host);
        assert!(err_of(run(&mut vm, "let a = [1, 2]\na[5]")).contains("out of bounds"));
        // huge / negative indices saturate to a miss, not a panic
        assert!(err_of(run(&mut vm, "let a = [1]\na[999999999999]")).contains("out of bounds"));
    }

    #[test]
    fn unknown_names_are_errors() {
        let mut vm = Vm::new(host);
        assert!(err_of(run(&mut vm, "nonexistent")).contains("unknown variable"));
        assert!(err_of(run(&mut vm, "frobnicate(1)")).contains("unknown function"));
        // unknown capability surfaces the host's error through the bridge
        assert!(err_of(run(&mut vm, "self.nope()")).contains("host error"));
    }

    // ---- deterministic fuzz: never panic, always terminate within fuel -

    /// Tiny deterministic LCG (Knuth MMIX constants). No Date/rand — the whole
    /// point of the sandbox is reproducibility, and the fuzz corpus must be
    /// identical on every machine and every run.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            // return the high bits, which mix better than the low bits
            self.0 >> 17
        }
    }

    /// Build a random-but-lexable token soup: a mix of identifiers, literals,
    /// operators, keywords, and builtin names, joined by spaces, with periodic
    /// bursts of opening brackets to probe the parser's depth guard.
    fn random_source(rng: &mut Lcg) -> String {
        const VOCAB: &[&str] = &[
            "let", "x", "y", "z", "=", "+", "-", "*", "/", "%", "(", ")", "[", "]", "{", "}",
            "if", "else", "while", "for", "in", "return", "true", "false", "null", "0", "1", "2",
            "-1", "3.14", "1e400", "999999999999", "\"a\"", "\"hello world\"", "\"\"", ".", "self",
            "orders", "add", "print", "len", "push", "keys", "range", "str", "num", "min", "max",
            "abs", "floor", "sort", "contains", "split", "join", "upper", "lower", "slice", "get",
            "==", "!=", "<", "<=", ">", ">=", "&&", "||", "!", ",", ";", ":", "return_result",
        ];
        let n = 3 + (rng.next() % 40) as usize;
        let mut parts: Vec<String> = Vec::with_capacity(n);
        for _ in 0..n {
            if rng.next() % 100 < 8 {
                // a burst of opening brackets, sometimes deep enough to trip
                // the depth guard — which must yield an Error, not a crash
                let d = 1 + (rng.next() % 30) as usize;
                let br = match rng.next() % 3 {
                    0 => "(",
                    1 => "[",
                    _ => "{",
                };
                for _ in 0..d {
                    parts.push(br.to_string());
                }
            } else {
                parts.push(VOCAB[(rng.next() as usize) % VOCAB.len()].to_string());
            }
        }
        parts.join(" ")
    }

    #[test]
    fn fuzz_never_panics_and_always_terminates() {
        // Silence the default panic hook so a (hypothetical) panic doesn't spam
        // stderr; we count them explicitly and assert zero.
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));

        let mut rng = Lcg(0x9E37_79B9_7F4A_7C15);
        let iters: u32 = 25_000;
        let mut panics: u32 = 0;
        let mut vm = Vm::new(host);
        for i in 0..iters {
            // periodically reset to also exercise the persisted-namespace path
            if i % 8 == 0 {
                vm = Vm::new(host);
            }
            let src = random_source(&mut rng);
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                // A modest fuel budget proves termination: the call MUST return
                // an Outcome (any variant) rather than diverge.
                vm.run_cell_outcome(&src, 50_000)
            }));
            match outcome {
                Ok(o) => {
                    // every result is one of the three legal outcomes — trivially
                    // true by the type, but we touch it to prove it returned
                    let _ = outcome_dbg(o);
                }
                Err(_) => panics += 1,
            }
        }

        std::panic::set_hook(prev);
        assert_eq!(
            panics, 0,
            "fuzzer observed {panics} panic(s) across {iters} iterations"
        );
        println!("fuzz: {iters} iterations, {panics} panics, all terminated within fuel");
    }

    fn outcome_dbg(o: Outcome) -> String {
        match o {
            Outcome::Result(v) => format!("Result({v:?})"),
            Outcome::Signal(v) => format!("Signal({v:?})"),
            Outcome::Error(e) => format!("Error({e})"),
        }
    }
}
