// Cluster tints for the light theme, in assignment order: consecutive entries
// are far apart on the colour wheel, so the first few domains of a workspace
// are always easy to tell apart. layout.json stores an index into this list
// per cluster, so appending entries is safe; reordering would recolour every
// existing diagram.
const HUES = [215, 140, 28, 280, 180, 340, 50, 250, 95, 0, 195, 310];

export const PALETTE = HUES.map((h) => ({
  // Comma syntax: SVG viewers that predate CSS Color 4 still parse it.
  fill: `hsl(${h}, 60%, 97%)`,
  stroke: `hsl(${h}, 40%, 80%)`,
  header: `hsl(${h}, 65%, 91%)`,
  label: `hsl(${h}, 65%, 30%)`,
}));
