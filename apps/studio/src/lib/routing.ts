export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

// A simple A* on a visibility graph / non-uniform grid
export function routeOrthogonal(
  start: Point,
  end: Point,
  startDir: 'left'|'right',
  endDir: 'left'|'right',
  boxes: Box[]
): Point[] {
  // We collect all important X and Y coordinates to form a grid.
  const xs = new Set<number>([start.x, end.x]);
  const ys = new Set<number>([start.y, end.y]);

  // Add box edges with some padding
  for (const b of boxes) {
    xs.add(b.left);
    xs.add(b.right);
    ys.add(b.top);
    ys.add(b.bottom);
  }

  // To allow routing around, add a bounding box around everything
  const allXs = Array.from(xs);
  const allYs = Array.from(ys);
  const minX = Math.min(...allXs) - 40;
  const maxX = Math.max(...allXs) + 40;
  const minY = Math.min(...allYs) - 40;
  const maxY = Math.max(...allYs) + 40;
  
  xs.add(minX); xs.add(maxX);
  ys.add(minY); ys.add(maxY);

  // We also want some midpoints to allow routing between aligned boxes
  const sortedXs = Array.from(xs).sort((a, b) => a - b);
  const sortedYs = Array.from(ys).sort((a, b) => a - b);
  
  const finalXs = new Set(sortedXs);
  const finalYs = new Set(sortedYs);
  
  for (let i = 0; i < sortedXs.length - 1; i++) {
    finalXs.add((sortedXs[i] + sortedXs[i+1]) / 2);
  }
  for (let i = 0; i < sortedYs.length - 1; i++) {
    finalYs.add((sortedYs[i] + sortedYs[i+1]) / 2);
  }

  const xArr = Array.from(finalXs).sort((a, b) => a - b);
  const yArr = Array.from(finalYs).sort((a, b) => a - b);

  const isSegmentInsideObstacle = (x1: number, y1: number, x2: number, y2: number) => {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    
    // We only care about horizontal or vertical segments
    return boxes.some(b => {
      if (y1 === y2) { // horizontal
        return y1 > b.top && y1 < b.bottom && minX < b.right && maxX > b.left;
      } else { // vertical
        return x1 > b.left && x1 < b.right && minY < b.bottom && maxY > b.top;
      }
    });
  };

  // Find start and end indices
  let startXIdx = xArr.findIndex(x => x >= start.x);
  let startYIdx = yArr.findIndex(y => y >= start.y);
  let endXIdx = xArr.findIndex(x => x >= end.x);
  let endYIdx = yArr.findIndex(y => y >= end.y);

  if (startXIdx === -1) startXIdx = 0;
  if (startYIdx === -1) startYIdx = 0;
  if (endXIdx === -1) endXIdx = 0;
  if (endYIdx === -1) endYIdx = 0;

  const startKey = `${startXIdx},${startYIdx}`;
  const endKey = `${endXIdx},${endYIdx}`;

  // Queue for BFS/Dijkstra
  const pq: {key: string, cost: number, path: Point[], xIdx: number, yIdx: number, dir: 'h'|'v'|'none'}[] = [];
  
  // To enforce the initial direction (leaving the source)
  if (startDir === 'left' && startXIdx > 0) {
    pq.push({ key: `${startXIdx-1},${startYIdx}`, cost: xArr[startXIdx] - xArr[startXIdx-1], path: [{x: start.x, y: start.y}, {x: xArr[startXIdx-1], y: start.y}], xIdx: startXIdx-1, yIdx: startYIdx, dir: 'h' });
  } else if (startDir === 'right' && startXIdx < xArr.length - 1) {
    pq.push({ key: `${startXIdx+1},${startYIdx}`, cost: xArr[startXIdx+1] - xArr[startXIdx], path: [{x: start.x, y: start.y}, {x: xArr[startXIdx+1], y: start.y}], xIdx: startXIdx+1, yIdx: startYIdx, dir: 'h' });
  } else {
    pq.push({ key: startKey, cost: 0, path: [{x: start.x, y: start.y}], xIdx: startXIdx, yIdx: startYIdx, dir: 'none' });
  }

  const visited = new Map<string, number>();

  while (pq.length > 0) {
    // Pop lowest cost
    pq.sort((a, b) => a.cost - b.cost);
    const curr = pq.shift()!;

    if (visited.has(curr.key) && visited.get(curr.key)! <= curr.cost) continue;
    visited.set(curr.key, curr.cost);

    if (curr.xIdx === endXIdx && curr.yIdx === endYIdx) {
      // Check if entering end correctly
      const lastPoint = curr.path[curr.path.length - 2] || curr.path[curr.path.length - 1];
      if (endDir === 'left' && lastPoint.x >= end.x) continue; // must enter from left
      if (endDir === 'right' && lastPoint.x <= end.x) continue; // must enter from right
      return curr.path;
    }

    const { xIdx, yIdx, cost, path, dir } = curr;
    const x = xArr[xIdx];
    const y = yArr[yIdx];

    // Try moving up, down, left, right
    const neighbors = [
      { dx: 1, dy: 0, nDir: 'h' as const },
      { dx: -1, dy: 0, nDir: 'h' as const },
      { dx: 0, dy: 1, nDir: 'v' as const },
      { dx: 0, dy: -1, nDir: 'v' as const }
    ];

    for (const { dx, dy, nDir } of neighbors) {
      const nxIdx = xIdx + dx;
      const nyIdx = yIdx + dy;

      if (nxIdx < 0 || nxIdx >= xArr.length || nyIdx < 0 || nyIdx >= yArr.length) continue;

      const nx = xArr[nxIdx];
      const ny = yArr[nyIdx];

      if (isSegmentInsideObstacle(x, y, nx, ny)) continue;

      let moveCost = Math.abs(nx - x) + Math.abs(ny - y);
      // Penalize turning
      if (dir !== 'none' && dir !== nDir) moveCost += 20;

      const nKey = `${nxIdx},${nyIdx}`;
      if (!visited.has(nKey) || visited.get(nKey)! > cost + moveCost) {
        pq.push({
          key: nKey,
          cost: cost + moveCost,
          path: [...path, { x: nx, y: ny }],
          xIdx: nxIdx,
          yIdx: nyIdx,
          dir: nDir
        });
      }
    }
  }

  // Fallback if no path found
  return [start, end];
}

// Smoothing the A* path into rounded SVG commands
export function pathToSvg(path: Point[], radius: number = 8): string {
  if (path.length < 2) return '';
  if (path.length === 2) {
    return `M ${path[0].x} ${path[0].y} L ${path[1].x} ${path[1].y}`;
  }

  // First simplify the path to only keep corners
  const simplified: Point[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = simplified[simplified.length - 1];
    const curr = path[i];
    const next = path[i + 1];
    
    const isHorizontal = prev.y === curr.y && curr.y === next.y;
    const isVertical = prev.x === curr.x && curr.x === next.x;
    
    if (!isHorizontal && !isVertical) {
      simplified.push(curr);
    }
  }
  simplified.push(path[path.length - 1]);

  let d = `M ${simplified[0].x} ${simplified[0].y} `;
  
  for (let i = 1; i < simplified.length - 1; i++) {
    const prev = simplified[i - 1];
    const curr = simplified[i];
    const next = simplified[i + 1];
    
    // Calculate vectors
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    
    const len1 = Math.sqrt(dx1*dx1 + dy1*dy1);
    const len2 = Math.sqrt(dx2*dx2 + dy2*dy2);
    
    const r = Math.min(radius, len1 / 2, len2 / 2);
    
    if (r === 0) {
      d += `L ${curr.x} ${curr.y} `;
      continue;
    }
    
    // p1 is the start of the curve
    const p1x = curr.x - (dx1 / len1) * r;
    const p1y = curr.y - (dy1 / len1) * r;
    
    // p2 is the end of the curve
    const p2x = curr.x + (dx2 / len2) * r;
    const p2y = curr.y + (dy2 / len2) * r;
    
    d += `L ${p1x} ${p1y} Q ${curr.x} ${curr.y} ${p2x} ${p2y} `;
  }
  
  const last = simplified[simplified.length - 1];
  d += `L ${last.x} ${last.y}`;
  
  return d;
}
