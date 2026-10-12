// Baumansicht: Tastaturnavigation über sichtbare Knoten (UI-SPEC §6, "In Listen").

export interface TreeNode {
  id: string;
  level: number;
  expandable: boolean;
  expanded: boolean;
  parentId: string | null;
}

export type TreeAction =
  | { type: 'move'; id: string }
  | { type: 'expand'; id: string }
  | { type: 'collapse'; id: string }
  | { type: 'activate'; id: string }
  | { type: 'none' };

const NONE: TreeAction = { type: 'none' };

interface Cursor {
  nodes: readonly TreeNode[];
  index: number;
  node: TreeNode | undefined;
}

function moveTo(cursor: Cursor, index: number): TreeAction {
  const clamped = Math.max(0, Math.min(cursor.nodes.length - 1, index));
  return { type: 'move', id: cursor.nodes[clamped].id };
}

function right({ node, index, nodes }: Cursor): TreeAction {
  if (!node?.expandable) return NONE;
  return node.expanded ? moveTo({ nodes, index, node }, index + 1) : { type: 'expand', id: node.id };
}

function left({ node }: Cursor): TreeAction {
  if (node?.expandable && node.expanded) return { type: 'collapse', id: node.id };
  return node?.parentId ? { type: 'move', id: node.parentId } : NONE;
}

function activate({ node }: Cursor): TreeAction {
  return node ? { type: 'activate', id: node.id } : NONE;
}

const HANDLERS: Readonly<Record<string, (cursor: Cursor) => TreeAction>> = {
  ArrowDown: (c) => moveTo(c, c.index + 1),
  ArrowUp: (c) => moveTo(c, c.index < 0 ? 0 : c.index - 1),
  Home: (c) => moveTo(c, 0),
  End: (c) => moveTo(c, c.nodes.length - 1),
  ArrowRight: right,
  ArrowLeft: left,
  Enter: activate,
  ' ': activate,
};

/** Reaktion auf eine Taste. `nodes` sind die sichtbaren Knoten in Anzeigereihenfolge. */
export function treeKeyAction(nodes: readonly TreeNode[], activeId: string | null, key: string): TreeAction {
  const handler = HANDLERS[key];
  if (!handler || nodes.length === 0) return NONE;
  const index = nodes.findIndex((n) => n.id === activeId);
  return handler({ nodes, index, node: index >= 0 ? nodes[index] : undefined });
}
