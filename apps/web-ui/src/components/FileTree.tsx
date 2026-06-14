import { useMemo } from 'react';
import type { GenFile } from '../generator';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  file?: GenFile;
}

function buildTree(files: GenFile[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    let acc = '';
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, path: acc, children: new Map() });
      }
      node = node.children.get(part)!;
      if (i === parts.length - 1) node.file = f;
    });
  }
  return root;
}

function Node({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string;
  onSelect: (f: GenFile) => void;
}) {
  const entries = [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 && !a.file;
    const bDir = b.children.size > 0 && !b.file;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <ul className={depth === 0 ? '' : 'border-l border-ink-700/70'}>
      {entries.map((child) => {
        const isFile = !!child.file && child.children.size === 0;
        const isSel = isFile && child.file!.path === selected;
        return (
          <li key={child.path}>
            <button
              type="button"
              onClick={() => child.file && onSelect(child.file)}
              disabled={!isFile}
              style={{ paddingLeft: depth * 12 + 8 }}
              className={`flex w-full items-center gap-1.5 rounded py-0.5 pr-2 text-left text-[13px] transition ${
                isSel ? 'bg-brand/20 text-white' : isFile ? 'text-slate-300 hover:bg-ink-700/50' : 'text-slate-400'
              }`}
            >
              <span aria-hidden className="opacity-70">
                {isFile ? '📄' : '📁'}
              </span>
              <span className="font-mono">{child.name}</span>
            </button>
            {child.children.size > 0 && (
              <Node node={child} depth={depth + 1} selected={selected} onSelect={onSelect} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function FileTree({
  files,
  selected,
  onSelect,
}: {
  files: GenFile[];
  selected: string;
  onSelect: (f: GenFile) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  return (
    <div className="scroll-thin max-h-[420px] overflow-auto p-1">
      <Node node={tree} depth={0} selected={selected} onSelect={onSelect} />
    </div>
  );
}
