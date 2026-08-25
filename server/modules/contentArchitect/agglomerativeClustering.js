// ── Stage 5d: efficient average-linkage agglomerative clustering ────────────
// Nearest-neighbor-chain algorithm (Müllner, "Modern hierarchical,
// agglomerative clustering algorithms", 2011) — O(n²) time, O(n²) space for
// the distance matrix. Written in-house after discovering ml-hclust's
// agnes() is a naive O(n³) implementation: every single merge does a full
// O(n²) scan of the distance matrix for the global minimum, then rebuilds an
// entirely new, smaller matrix by copying values across. That never finished
// on a real 3,353-page site (killed after several minutes). This produces
// the same binary merge-tree shape (children/height/isLeaf/indices()/cut())
// so the rest of this module's cluster-cleanup logic is unaffected by the
// swap. Cross-validated against ml-hclust's own (slow but correct) agnes()
// on small/medium inputs before being trusted at full scale — see the
// Checkpoint 2 report.
class ClusterNode {
  constructor() {
    this.children = [];
    this.height = 0;
    this.size = 1;
    this.index = -1;
    this.isLeaf = false;
  }

  // Same semantics as ml-hclust's Cluster.cut(): every returned node has
  // height below `threshold` (or is a leaf), i.e. it wasn't merged into
  // anything larger below that distance.
  cut(threshold) {
    const result = [];
    const visit = (node) => {
      if (node.isLeaf || node.height < threshold) {
        result.push(node);
        return;
      }
      for (const child of node.children) visit(child);
    };
    visit(this);
    return result;
  }

  indices() {
    if (this.isLeaf) return [this.index];
    const result = [];
    for (const child of this.children) result.push(...child.indices());
    return result;
  }
}

// Lance-Williams update for average linkage (UPGMA) — the same formula
// ml-hclust's averageLink uses; only the surrounding bookkeeping differs.
function averageLinkageUpdate(dKI, dKJ, ni, nj) {
  return (ni * dKI + nj * dKJ) / (ni + nj);
}

// distanceMatrix: full symmetric N×N array (plain arrays or typed arrays).
// Returns the root ClusterNode of the merge tree.
function agglomerativeAverageLinkage(distanceMatrix) {
  const n = distanceMatrix.length;
  if (n === 0) throw new Error('Cannot cluster an empty input.');
  if (n === 1) {
    const leaf = new ClusterNode();
    leaf.isLeaf = true;
    leaf.index = 0;
    return leaf;
  }

  // D is a mutable working copy. Merged-away slots are left in place and
  // marked inactive rather than physically removed — resizing/copying is
  // exactly the O(n) per-merge cost this algorithm avoids.
  const D = distanceMatrix.map((row) => Float64Array.from(row));
  const active = new Array(n).fill(true);
  const size = new Array(n).fill(1);
  const node = new Array(n);
  for (let i = 0; i < n; i++) {
    const leaf = new ClusterNode();
    leaf.isLeaf = true;
    leaf.index = i;
    node[i] = leaf;
  }

  let activeCount = n;
  const chain = [];

  function nearestActive(x) {
    let best = -1;
    let bestDist = Infinity;
    for (let z = 0; z < n; z++) {
      if (!active[z] || z === x) continue;
      const d = D[x][z];
      if (d < bestDist) { bestDist = d; best = z; }
    }
    return [best, bestDist];
  }

  function firstActive() {
    for (let i = 0; i < n; i++) if (active[i]) return i;
    return -1;
  }

  while (activeCount > 1) {
    if (chain.length === 0) chain.push(firstActive());

    let a = -1;
    let b = -1;
    let mergeDist = 0;
    for (;;) {
      const x = chain[chain.length - 1];
      const [nearest, nearestDist] = nearestActive(x);
      if (chain.length > 1 && nearest === chain[chain.length - 2]) {
        b = chain.pop();
        a = chain.pop();
        mergeDist = nearestDist;
        break;
      }
      chain.push(nearest);
    }

    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const merged = new ClusterNode();
    merged.children = [node[lo], node[hi]];
    merged.height = mergeDist;
    merged.size = size[lo] + size[hi];

    for (let z = 0; z < n; z++) {
      if (!active[z] || z === lo || z === hi) continue;
      const updated = averageLinkageUpdate(D[lo][z], D[hi][z], size[lo], size[hi]);
      D[lo][z] = updated;
      D[z][lo] = updated;
    }

    node[lo] = merged;
    active[hi] = false;
    size[lo] = merged.size;
    activeCount--;
  }

  return node[firstActive()];
}

module.exports = { agglomerativeAverageLinkage, ClusterNode };
