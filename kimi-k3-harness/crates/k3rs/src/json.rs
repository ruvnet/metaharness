//! Minimal JSON parser — just enough for config.json and the safetensors header.
//! No external crates by design (the C engine vendors a header-only parser for the
//! same reason).

use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub enum J {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<J>),
    Obj(BTreeMap<String, J>),
}

impl J {
    pub fn get(&self, key: &str) -> Option<&J> {
        match self {
            J::Obj(m) => m.get(key),
            _ => None,
        }
    }
    pub fn as_i(&self) -> Option<i64> {
        match self {
            J::Num(n) => Some(*n as i64),
            _ => None,
        }
    }
    pub fn as_f(&self) -> Option<f64> {
        match self {
            J::Num(n) => Some(*n),
            _ => None,
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            J::Bool(b) => Some(*b),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            J::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_arr(&self) -> Option<&[J]> {
        match self {
            J::Arr(a) => Some(a),
            _ => None,
        }
    }
    pub fn as_obj(&self) -> Option<&BTreeMap<String, J>> {
        match self {
            J::Obj(m) => Some(m),
            _ => None,
        }
    }
}

pub fn parse(s: &str) -> Result<J, String> {
    let b = s.as_bytes();
    let mut p = 0usize;
    let v = value(b, &mut p)?;
    skip_ws(b, &mut p);
    Ok(v)
}

fn skip_ws(b: &[u8], p: &mut usize) {
    while *p < b.len() && matches!(b[*p], b' ' | b'\t' | b'\n' | b'\r') {
        *p += 1;
    }
}

fn value(b: &[u8], p: &mut usize) -> Result<J, String> {
    skip_ws(b, p);
    if *p >= b.len() {
        return Err("unexpected end".into());
    }
    match b[*p] {
        b'{' => {
            *p += 1;
            let mut m = BTreeMap::new();
            skip_ws(b, p);
            if *p < b.len() && b[*p] == b'}' {
                *p += 1;
                return Ok(J::Obj(m));
            }
            loop {
                skip_ws(b, p);
                let k = match value(b, p)? {
                    J::Str(s) => s,
                    _ => return Err("object key is not a string".into()),
                };
                skip_ws(b, p);
                if *p >= b.len() || b[*p] != b':' {
                    return Err("expected ':'".into());
                }
                *p += 1;
                let v = value(b, p)?;
                m.insert(k, v);
                skip_ws(b, p);
                match b.get(*p) {
                    Some(b',') => *p += 1,
                    Some(b'}') => {
                        *p += 1;
                        return Ok(J::Obj(m));
                    }
                    _ => return Err("expected ',' or '}'".into()),
                }
            }
        }
        b'[' => {
            *p += 1;
            let mut a = Vec::new();
            skip_ws(b, p);
            if *p < b.len() && b[*p] == b']' {
                *p += 1;
                return Ok(J::Arr(a));
            }
            loop {
                a.push(value(b, p)?);
                skip_ws(b, p);
                match b.get(*p) {
                    Some(b',') => *p += 1,
                    Some(b']') => {
                        *p += 1;
                        return Ok(J::Arr(a));
                    }
                    _ => return Err("expected ',' or ']'".into()),
                }
            }
        }
        b'"' => {
            *p += 1;
            let mut s = String::new();
            while *p < b.len() {
                match b[*p] {
                    b'"' => {
                        *p += 1;
                        return Ok(J::Str(s));
                    }
                    b'\\' => {
                        *p += 1;
                        match b.get(*p) {
                            Some(b'"') => s.push('"'),
                            Some(b'\\') => s.push('\\'),
                            Some(b'/') => s.push('/'),
                            Some(b'n') => s.push('\n'),
                            Some(b't') => s.push('\t'),
                            Some(b'r') => s.push('\r'),
                            Some(b'b') => s.push('\u{8}'),
                            Some(b'f') => s.push('\u{c}'),
                            Some(b'u') => {
                                let h = std::str::from_utf8(&b[*p + 1..*p + 5])
                                    .map_err(|_| "bad \\u escape")?;
                                let cp = u32::from_str_radix(h, 16).map_err(|_| "bad \\u escape")?;
                                s.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                                *p += 4;
                            }
                            _ => return Err("bad escape".into()),
                        }
                        *p += 1;
                    }
                    c => {
                        // Raw UTF-8 bytes pass straight through.
                        let start = *p;
                        let mut end = *p + 1;
                        if c >= 0x80 {
                            while end < b.len() && (b[end] & 0xC0) == 0x80 {
                                end += 1;
                            }
                        }
                        s.push_str(
                            std::str::from_utf8(&b[start..end]).map_err(|_| "bad utf8")?,
                        );
                        *p = end;
                    }
                }
            }
            Err("unterminated string".into())
        }
        b't' => {
            if b[*p..].starts_with(b"true") {
                *p += 4;
                Ok(J::Bool(true))
            } else {
                Err("bad literal".into())
            }
        }
        b'f' => {
            if b[*p..].starts_with(b"false") {
                *p += 5;
                Ok(J::Bool(false))
            } else {
                Err("bad literal".into())
            }
        }
        b'n' => {
            if b[*p..].starts_with(b"null") {
                *p += 4;
                Ok(J::Null)
            } else {
                Err("bad literal".into())
            }
        }
        _ => {
            let start = *p;
            while *p < b.len()
                && matches!(b[*p], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
            {
                *p += 1;
            }
            let s = std::str::from_utf8(&b[start..*p]).map_err(|_| "bad number")?;
            s.parse::<f64>().map(J::Num).map_err(|e| e.to_string())
        }
    }
}
