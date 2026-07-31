// Isometric voxel projection: a set of cubes in, a list of drawable faces out.
//
// Dependency-free and generic — it knows nothing about creatures. Given a map of
// occupied cells it culls the faces you can't see, projects the rest, and hands
// back polygons in painter order. lib/creatureparts.js decides which cells are
// occupied; CreatureSprite.vue turns these faces into SVG.
//
// ── The projection ───────────────────────────────────────────────────────────
//
//   sx = (x - z) · HW              x runs right-and-down, z runs left-and-down,
//   sy = (x + z) · HH - y · V      y runs up
//
// so the camera sits above and in front, and exactly three faces of any cube can
// face it: the top (+y), the right (+x) and the left (+z). Everything else is
// culled before it is ever built.
//
// Every constant below is an integer and the projection only ever multiplies by
// them, so all polygon vertices land on whole units. That is what keeps the
// result PIXEL art rather than a smoothly-antialiased 3D render — combined with
// `shape-rendering: crispEdges` in the component, cube edges stay hard at every
// size.

// Half-width, half-depth (the top face's half-height) and the height of a
// vertical face. HW = 2·HH is the classic 2:1 isometric ratio.
export const HW = 2;
export const HH = 1;
export const V = 2;

// Which face is which, so callers can shade them. TOP is lit, LEFT is the +z
// face, RIGHT is the +x face.
export const FACE = { TOP: 0, LEFT: 1, RIGHT: 2 };

export function voxelKey(x, y, z) {
  return `${x},${y},${z}`;
}

// Project one cube's three visible faces. Returns polygon point strings, ready
// for an SVG `points` attribute.
function facesOf(x, y, z) {
  const sx = (x - z) * HW;
  const sy = (x + z) * HH - y * V;
  return {
    [FACE.TOP]: `${sx},${sy} ${sx + HW},${sy + HH} ${sx},${sy + 2 * HH} ${sx - HW},${sy + HH}`,
    [FACE.LEFT]:
      `${sx - HW},${sy + HH} ${sx},${sy + 2 * HH} ${sx},${sy + 2 * HH + V} ${sx - HW},${sy + HH + V}`,
    [FACE.RIGHT]:
      `${sx},${sy + 2 * HH} ${sx + HW},${sy + HH} ${sx + HW},${sy + HH + V} ${sx},${sy + 2 * HH + V}`,
  };
}

// Turn a voxel map into drawable faces.
//
//   voxels — Map of voxelKey() -> a caller-defined slot (a palette index here)
//
// Returns `{ faces, viewBox }`, faces sorted back-to-front. Face culling is what
// makes this cheap: a solid 200-cube creature has well under half its faces
// exposed, and the ones inside it are never allocated.
export function project(voxels) {
  const cells = [];
  for (const [key, slot] of voxels) {
    const [x, y, z] = key.split(",").map(Number);
    cells.push({ x, y, z, slot });
  }

  // Painter's algorithm. Larger (x + z) is nearer the camera and so drawn later;
  // y breaks ties within a column, lower first. With hidden faces already culled
  // this ordering is exact for the shapes a creature is made of.
  cells.sort((a, b) => a.x + a.z - (b.x + b.z) || a.y - b.y);

  const faces = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const track = (points) => {
    for (const pair of points.split(" ")) {
      const [px, py] = pair.split(",").map(Number);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
  };

  for (const cell of cells) {
    const { x, y, z, slot } = cell;
    const geometry = facesOf(x, y, z);
    // A face is invisible exactly when another cube is stacked against it.
    if (!voxels.has(voxelKey(x, y + 1, z))) {
      faces.push({ points: geometry[FACE.TOP], slot, face: FACE.TOP });
      track(geometry[FACE.TOP]);
    }
    if (!voxels.has(voxelKey(x, y, z + 1))) {
      faces.push({ points: geometry[FACE.LEFT], slot, face: FACE.LEFT });
      track(geometry[FACE.LEFT]);
    }
    if (!voxels.has(voxelKey(x + 1, y, z))) {
      faces.push({ points: geometry[FACE.RIGHT], slot, face: FACE.RIGHT });
      track(geometry[FACE.RIGHT]);
    }
  }

  if (!faces.length) return { faces, viewBox: "0 0 1 1" };

  // One unit of padding so a stroke or a rounding error can't clip an edge.
  const pad = 1;
  return {
    faces,
    viewBox: `${minX - pad} ${minY - pad} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
  };
}

// Shade a slot's base colour for a given face. Multiplicative on lightness, so
// one authored colour per palette slot yields a lit solid — top brightest, the
// +x face darkest, which is what reads as volume.
//
// Takes an [h, s, l] triple rather than a CSS string: the whole point is to
// derive three related colours, and parsing a hex back out to do that would be
// silly.
export function shade([h, s, l], face) {
  const lightness = face === FACE.TOP ? l * 1.28 : face === FACE.LEFT ? l : l * 0.72;
  return `hsl(${h} ${s}% ${Math.max(4, Math.min(94, lightness)).toFixed(1)}%)`;
}
