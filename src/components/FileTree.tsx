import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen, FileText, FileImage, FileType } from 'lucide-react';
import type { DirEntry, DirListResult } from '../types';

interface FileTreeProps {
  sessionId: string | null;
  onViewFile: (relativePath: string) => void;
  viewingPath: string | null;
}

interface TreeNode {
  entry: DirEntry;
  relativePath: string;
  children: TreeNode[] | null;
  loading: boolean;
  expanded: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(ext: string) {
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']);
  const docExts = new Set(['pdf', 'docx', 'doc']);
  if (imageExts.has(ext)) return <FileImage size={14} aria-hidden="true" />;
  if (docExts.has(ext)) return <FileType size={14} aria-hidden="true" />;
  if (ext === 'md' || ext === 'markdown' || ext === 'txt') return <FileText size={14} aria-hidden="true" />;
  return <File size={14} aria-hidden="true" />;
}

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const n of nodes) {
    if (n.relativePath === path) return n;
    if (n.children) {
      const found = findNode(n.children, path);
      if (found) return found;
    }
  }
  return null;
}

function expandAndFill(
  nodes: TreeNode[],
  path: string,
  children: TreeNode[],
): TreeNode[] {
  return nodes.map((n) => {
    if (n.relativePath === path) {
      return { ...n, expanded: true, loading: false, children };
    }
    if (n.children) {
      return { ...n, children: expandAndFill(n.children, path, children) };
    }
    return n;
  });
}

export function FileTree({ sessionId, onViewFile, viewingPath }: FileTreeProps) {
  const [roots, setRoots] = useState<TreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadToken = useRef(0);
  const rootsRef = useRef<TreeNode[]>(roots);
  const revealingRef = useRef<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  const fetchDir = useCallback(async (dirPath: string): Promise<DirEntry[]> => {
    if (!sessionId) return [];
    const res: DirListResult = await window.vibeMeet.documents.list(sessionId, dirPath);
    if (!res.ok) throw new Error(res.error);
    return res.entries;
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setRoots([]);
      setLoading(false);
      return;
    }
    const token = ++loadToken.current;
    setLoading(true);
    setError(null);
    fetchDir('').then((entries) => {
      if (token !== loadToken.current) return;
      setRoots(entries.map((e) => ({
        entry: e,
        relativePath: e.name,
        children: null,
        loading: false,
        expanded: false,
      })));
      setLoading(false);
    }).catch((err: unknown) => {
      if (token !== loadToken.current) return;
      setError(err instanceof Error ? err.message : 'Failed to list directory');
      setLoading(false);
    });
  }, [sessionId, fetchDir]);

  const toggleFolder = useCallback(async (path: string) => {
    const updateNodes = (nodes: TreeNode[]): TreeNode[] =>
      nodes.map((n) => {
        if (n.relativePath === path) {
          if (n.expanded) {
            return { ...n, expanded: false };
          }
          if (n.children !== null) {
            return { ...n, expanded: true };
          }
          return { ...n, loading: true, expanded: true };
        }
        if (n.children) {
          return { ...n, children: updateNodes(n.children) };
        }
        return n;
      });

    setRoots((prev) => updateNodes(prev));

    try {
      const entries = await fetchDir(path);
      const children: TreeNode[] = entries.map((e) => ({
        entry: e,
        relativePath: `${path}/${e.name}`,
        children: null,
        loading: false,
        expanded: false,
      }));

      const fillChildren = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.relativePath === path) {
            return { ...n, children, loading: false };
          }
          if (n.children) {
            return { ...n, children: fillChildren(n.children) };
          }
          return n;
        });

      setRoots((prev) => fillChildren(prev));
    } catch {
      const clearLoading = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) => {
          if (n.relativePath === path) {
            return { ...n, loading: false, expanded: false };
          }
          if (n.children) {
            return { ...n, children: clearLoading(n.children) };
          }
          return n;
        });
      setRoots((prev) => clearLoading(prev));
    }
  }, [fetchDir]);

  useEffect(() => { rootsRef.current = roots; }, [roots]);

  useEffect(() => {
    if (!viewingPath || !sessionId) return;
    if (revealingRef.current === viewingPath) return;

    const segments = viewingPath.split('/');
    const ancestorPaths: string[] = [];
    for (let i = 1; i < segments.length; i++) {
      ancestorPaths.push(segments.slice(0, i).join('/'));
    }
    if (ancestorPaths.length === 0) return;

    revealingRef.current = viewingPath;

    void (async () => {
      for (const dirPath of ancestorPaths) {
        if (revealingRef.current !== viewingPath) return;

        const node = findNode(rootsRef.current, dirPath);
        if (!node) break;
        if (node.expanded && node.children !== null) continue;

        try {
          const entries = await fetchDir(dirPath);
          if (revealingRef.current !== viewingPath) return;
          const children: TreeNode[] = entries.map((e) => ({
            entry: e,
            relativePath: `${dirPath}/${e.name}`,
            children: null,
            loading: false,
            expanded: false,
          }));
          setRoots((prev) => {
            const next = expandAndFill(prev, dirPath, children);
            rootsRef.current = next;
            return next;
          });
        } catch {
          break;
        }
      }

      if (revealingRef.current === viewingPath) {
        requestAnimationFrame(() => {
          treeRef.current
            ?.querySelector('.file-tree-file.active')
            ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        });
      }
      revealingRef.current = null;
    })();
  }, [viewingPath, sessionId, fetchDir]);

  const renderNode = (node: TreeNode, depth: number) => {
    const isActive = viewingPath === node.relativePath;

    if (node.entry.isDir) {
      return (
        <div key={node.relativePath}>
          <div
            className={`file-tree-row file-tree-folder${node.expanded ? ' expanded' : ''}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            role="button"
            tabIndex={0}
            onClick={() => void toggleFolder(node.relativePath)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void toggleFolder(node.relativePath);
              }
            }}
          >
            <span className="file-tree-chevron" aria-hidden="true">
              <ChevronRight size={12} />
            </span>
            {node.expanded
              ? <FolderOpen size={14} aria-hidden="true" />
              : <Folder size={14} aria-hidden="true" />}
            <span className="file-tree-name">{node.entry.name}</span>
            {node.loading && <span className="file-tree-spinner" />}
          </div>
          {node.expanded && node.children && (
            <div className="file-tree-children">
              {node.children.length === 0 && (
                <div
                  className="file-tree-empty"
                  style={{ paddingLeft: `${12 + (depth + 1) * 16}px` }}
                >
                  (empty)
                </div>
              )}
              {node.children.map((child) => renderNode(child, depth + 1))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        key={node.relativePath}
        className={`file-tree-row file-tree-file${isActive ? ' active' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        role="button"
        tabIndex={0}
        onClick={() => onViewFile(node.relativePath)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onViewFile(node.relativePath);
          }
        }}
      >
        {fileIcon(node.entry.ext)}
        <span className="file-tree-name">{node.entry.name}</span>
        <span className="file-tree-size">{formatBytes(node.entry.size)}</span>
      </div>
    );
  };

  if (!sessionId) {
    return <div className="file-tree-empty-root">Join a meeting to browse files.</div>;
  }

  if (loading) {
    return <div className="file-tree-empty-root"><span className="file-tree-spinner" /> Loading...</div>;
  }

  if (error) {
    return <div className="file-tree-empty-root">{error}</div>;
  }

  if (roots.length === 0) {
    return <div className="file-tree-empty-root">No files in workspace.</div>;
  }

  return (
    <div className="file-tree" ref={treeRef}>
      {roots.map((node) => renderNode(node, 0))}
    </div>
  );
}
