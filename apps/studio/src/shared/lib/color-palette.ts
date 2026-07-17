const NODE_COLORS = ['#c3c0ff', '#ffb695', '#a7f3d0', '#fde68a', '#fbcfe8', '#93c5fd'];

export function getNodeColor(index: number, override?: string): string {
  return override ?? NODE_COLORS[index % NODE_COLORS.length];
}
