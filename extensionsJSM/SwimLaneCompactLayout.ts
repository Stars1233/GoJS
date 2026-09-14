/*
 *  Copyright 1998-2026 by Northwoods Software Corporation. All Rights Reserved.
 */

/*
 * This is an extension and not part of the main GoJS library.
 * The source code for this is at extensionsJSM/SwimLaneCompactLayout.ts.
 * Note that the API for this class may change with any version, even point releases.
 * If you intend to use an extension in production, you should copy the code to your own source directory.
 * Extensions can be found in the GoJS kit under the extensions or extensionsJSM folders.
 * See the Extensions learn page (https://gojs.net/learn/extensions) for more information.
 */

import go from 'gojs';

interface LaneNodeInfo {
  node: go.Node;
  row: number;
  col: number;
  lcol: number;
  idx: number;
  indeg: number;
  preds: Array<LaneNodeInfo>;
  succs: Array<LaneNodeInfo>;
  // abstract bounds during commit: u along the flow axis, v across the lanes
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

interface LaneComponent {
  members: Array<LaneNodeInfo>;
  preds: Array<LaneComponent>;
  succs: Array<LaneComponent>;
  indeg: number;
  rowMin: number;
  rowMax: number;
  width: number;
  minIdx: number;
}

interface LaneRoute {
  // grid cells and lane-boundary segments packed as numbers via cellKey/segKey
  hCells: Array<number>;
  vCells: Array<number>;
  vSegs: Array<number>;
  cost: number;
  shape: string;
}

interface PredEdge {
  p: LaneNodeInfo;
  m: LaneNodeInfo;
}

interface ChannelRun {
  lo: number;
  hi: number;
  off: number;
  max: number;
}

interface RoutePlan {
  link: go.Link;
  shape: string;
  fi: LaneNodeInfo;
  ti: LaneNodeInfo;
  h: ChannelRun | null;
  v: ChannelRun | null;
  v2: ChannelRun | null;
}

/**
 * A custom {@link go.Layout} that positions nodes into swimlanes on an
 * occupancy grid. Unlike {@link SwimLaneLayout}, a link between nodes in different lanes
 * does not force an advancement of a column. In this layout changing lanes implies the same
 * progression as going further in the same lane.
 *
 * This assumes that each Node.data.lane property is a string that names the lane the node should be in.
 * You can set the {@link laneProperty} property to use a different data property name.
 * It is commonplace to set this property to be the same as the {@link go.GraphLinksModel.nodeGroupKeyProperty},
 * so that the one property indicates that a particular node data is a member of a particular group
 * and thus that that group represents a lane.
 * Each lane group is expected to have an object named 'PLACEHOLDER',
 * which is sized and positioned by the layout to form the lane band.
 *
 * When {@link cycleBlocks} is true, each cycle in the graph is laid out as a compact
 * block that reserves room for the loop's return links.
 *
 * When {@link setsPortSpots} and {@link setsRoutePoints} are true, links are placed and routed
 * to improve readability. Links are routed orthogonally either going across lanes or down a lane.
 *
 * If you want to experiment with this extension, try the <a href="/samples/swimLaneCompact">Swim Lane Compact</a> sample.
 * @category Layout Extension
 */
export class SwimLaneCompactLayout extends go.Layout {
  // packing factor for (row, column) and (column, boundary) keys; columns stay
  // far below this and rows are small, so packed keys are exact integers
  private static readonly PK = 1 << 20;

  // shared empty set for route evaluations that carry no tentative claims
  private static readonly NO_EXTRA = new Set<number>();

  // route shape candidates by the relative position of the endpoints
  private static readonly SHAPES_SAME_LANE = ['H', 'U', 'D'];
  private static readonly SHAPES_SAME_COL = ['H'];
  private static readonly SHAPES_CROSS = ['H', 'V'];

  // settable properties
  private _laneProperty: string | ((d: any) => string);
  private _laneNames: Array<string>;
  private _laneComparer: ((a: string, b: string) => number) | null;
  private _cycleBlocks: boolean;
  private _maxCycleBlockSize: number;
  private _direction: number;
  private _layerSpacing: number;
  private _laneSpacing: number;
  private _lanePadding: number;
  private _minLaneHeight: number;
  private _minColumnWidth: number;
  private _channelSpacing: number;
  private _setsPortSpots: boolean;
  private _setsRoutePoints: boolean;

  // internal state, valid only during a layout
  private _info: Map<go.Node, LaneNodeInfo>;
  private _infos: Array<LaneNodeInfo>;
  private _lanes: Array<string>;
  // one row per lane; cell codes: undefined free, 1 node, 2 link corridor, 3 block-reserved
  private _grid: Array<Array<number | undefined>>;
  private _hUse: Map<number, number>;
  private _vUse: Map<number, number>;
  private _edgeShape: Map<number, string>;
  private _routeRec: Map<number, LaneRoute>;
  private _sideOut: Map<string, Set<string>>;
  private _maxCol: number;

  constructor(init?: Partial<SwimLaneCompactLayout>) {
    super();
    this._laneProperty = 'lane';
    this._laneNames = [];
    this._laneComparer = null;
    this._cycleBlocks = false;
    this._maxCycleBlockSize = 8;
    this._direction = 0;
    this._layerSpacing = 40;
    this._laneSpacing = 0;
    this._lanePadding = 15;
    this._minLaneHeight = 50;
    this._minColumnWidth = 40;
    this._channelSpacing = 8;
    this._setsPortSpots = true;
    this._setsRoutePoints = true;
    this._info = new Map();
    this._infos = [];
    this._lanes = [];
    this._grid = [];
    this._hUse = new Map();
    this._vUse = new Map();
    this._edgeShape = new Map();
    this._routeRec = new Map();
    this._sideOut = new Map();
    this._maxCol = 0;
    if (init) Object.assign(this, init);
  }

  /**
   * Gets or sets the name of the data property that holds the string which is the name of the lane that the node should be in.
   * The default value is "lane".
   */
  get laneProperty(): string | ((d: any) => string) {
    return this._laneProperty;
  }
  set laneProperty(val: string | ((d: any) => string)) {
    if (typeof val !== 'string' && typeof val !== 'function')
      throw new Error(
        'new value for SwimLaneCompactLayout.laneProperty must be a property name, not: ' + val
      );
    if (this._laneProperty !== val) {
      this._laneProperty = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets an Array of lane names.
   * If you set this before a layout happens, it will use those lanes in that order.
   * Any additional lane names that it discovers will be added to the end of this Array.
   *
   * This property is reset to an empty Array at the end of each layout.
   * The default value is an empty Array.
   */
  get laneNames(): Array<string> {
    return this._laneNames;
  }
  set laneNames(val: Array<string>) {
    if (!Array.isArray(val))
      throw new Error('new value for SwimLaneCompactLayout.laneNames must be an Array, not: ' + val);
    if (this._laneNames !== val) {
      this._laneNames = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets a function by which to compare lane names, for ordering the lanes within the {@link laneNames} Array.
   * By default the function is null -- the lanes are not sorted.
   */
  get laneComparer(): ((a: string, b: string) => number) | null {
    return this._laneComparer;
  }
  set laneComparer(val: ((a: string, b: string) => number) | null) {
    if (val !== null && typeof val !== 'function')
      throw new Error(
        'new value for SwimLaneCompactLayout.laneComparer must be a function or null, not: ' + val
      );
    if (this._laneComparer !== val) {
      this._laneComparer = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets whether strongly connected components are laid out as
   * compact blocks before placing the rest of the diagram. 
   * The default value is false.
   */
  get cycleBlocks(): boolean {
    return this._cycleBlocks;
  }
  set cycleBlocks(val: boolean) {
    val = !!val;
    if (this._cycleBlocks !== val) {
      this._cycleBlocks = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the largest strongly connected component that {@link cycleBlocks}
   * treats as a block. Larger components will revert to normal placement.
   * The default value is 8.
   */
  get maxCycleBlockSize(): number {
    return this._maxCycleBlockSize;
  }
  set maxCycleBlockSize(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.maxCycleBlockSize must be a non-negative number, not: ' +
          val
      );
    if (this._maxCycleBlockSize !== val) {
      this._maxCycleBlockSize = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the direction the graph grows towards. 
   * 0 is towards the right, 90 is downwards, 180 is towards the left, 
   * and 270 is upwards. 
   * The default value is 0.
   */
  get direction(): number {
    return this._direction;
  }
  set direction(val: number) {
    if (val !== 0 && val !== 90 && val !== 180 && val !== 270)
      throw new Error(
        'new value for SwimLaneCompactLayout.direction must be 0, 90, 180, or 270, not: ' + val
      );
    if (this._direction !== val) {
      this._direction = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the gap between grid columns, measured
   * along the flow direction. Links routed across columns travel inside these gaps.
   * The default value is 40.
   */
  get layerSpacing(): number {
    return this._layerSpacing;
  }
  set layerSpacing(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.layerSpacing must be a non-negative number, not: ' + val
      );
    if (this._layerSpacing !== val) {
      this._layerSpacing = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the document-coordinate gap between adjacent lane bands.
   * The default value is 0, so the lane bands touch.
   */
  get laneSpacing(): number {
    return this._laneSpacing;
  }
  set laneSpacing(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.laneSpacing must be a non-negative number, not: ' + val
      );
    if (this._laneSpacing !== val) {
      this._laneSpacing = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the padding inside each lane on both sides of its broadest node.
   * The default value is 15.
   */
  get lanePadding(): number {
    return this._lanePadding;
  }
  set lanePadding(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.lanePadding must be a non-negative number, not: ' + val
      );
    if (this._lanePadding !== val) {
      this._lanePadding = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the minimum breadth of a lane band (its height for horizontal
   * lanes, its width for vertical ones), used by lanes with no nodes.
   * The default value is 50.
   */
  get minLaneHeight(): number {
    return this._minLaneHeight;
  }
  set minLaneHeight(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.minLaneHeight must be a non-negative number, not: ' + val
      );
    if (this._minLaneHeight !== val) {
      this._minLaneHeight = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the minimum width of a grid column.
   * The default value is 40.
   */
  get minColumnWidth(): number {
    return this._minColumnWidth;
  }
  set minColumnWidth(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.minColumnWidth must be a non-negative number, not: ' + val
      );
    if (this._minColumnWidth !== val) {
      this._minColumnWidth = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets the document-coordinate offset between links that share a
   * routing channel: co-traveling runs fan out by this many pixels each so
   * logical sharing never draws as visual overlap.
   * The default value is 8.
   */
  get channelSpacing(): number {
    return this._channelSpacing;
  }
  set channelSpacing(val: number) {
    if (typeof val !== 'number' || isNaN(val) || val < 0)
      throw new Error(
        'new value for SwimLaneCompactLayout.channelSpacing must be a non-negative number, not: ' + val
      );
    if (this._channelSpacing !== val) {
      this._channelSpacing = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets whether the layout assigns each link's fromSpot and toSpot to
   * match its chosen route shape.
   * The default value is true.
   */
  get setsPortSpots(): boolean {
    return this._setsPortSpots;
  }
  set setsPortSpots(val: boolean) {
    val = !!val;
    if (this._setsPortSpots !== val) {
      this._setsPortSpots = val;
      this.invalidateLayout();
    }
  }

  /**
   * Gets or sets whether the layout assigns each routed link an explicit list of
   * route points tracing its reserved corridor (guaranteeing links never cross
   * nodes), with links that found no corridor set to AvoidsNodes routing.
   * When false, links are left to normal routing guided only by spots.
   * The default value is true.
   */
  get setsRoutePoints(): boolean {
    return this._setsRoutePoints;
  }
  set setsRoutePoints(val: boolean) {
    val = !!val;
    if (this._setsRoutePoints !== val) {
      this._setsRoutePoints = val;
      this.invalidateLayout();
    }
  }

  /**
   * Copies properties to a cloned Layout.
   */
  override cloneProtected(copy: this): void {
    super.cloneProtected(copy);
    copy._laneProperty = this._laneProperty;
    copy._laneNames = this._laneNames;
    copy._laneComparer = this._laneComparer;
    copy._cycleBlocks = this._cycleBlocks;
    copy._maxCycleBlockSize = this._maxCycleBlockSize;
    copy._direction = this._direction;
    copy._layerSpacing = this._layerSpacing;
    copy._laneSpacing = this._laneSpacing;
    copy._lanePadding = this._lanePadding;
    copy._minLaneHeight = this._minLaneHeight;
    copy._minColumnWidth = this._minColumnWidth;
    copy._channelSpacing = this._channelSpacing;
    copy._setsPortSpots = this._setsPortSpots;
    copy._setsRoutePoints = this._setsRoutePoints;
  }

  /**
   * Positions all of the nodes and routes all of the links.
   * @param coll - A {@link go.Diagram} or a {@link go.Group} or a collection of {@link go.Part}s.
   */
  override doLayout(coll: go.Diagram | go.Group | go.Iterable<go.Part>): void {
    const diagram = this.diagram;
    if (diagram === null) return;
    this.arrangementOrigin = this.initialOrigin(this.arrangementOrigin);
    this.resetState();
    const links = this.collectGraph(coll);
    if (this._lanes.length === 0) {
      this.resetState();
      return;
    }
    // implementations of doLayout that do not make use of a LayoutNetwork
    // need to perform their own transactions
    diagram.startTransaction('SwimLaneCompactLayout');
    const compOf = new Map<LaneNodeInfo, LaneComponent>();
    const comps = this.buildComponents(compOf);
    const order = this.orderComponents(comps);
    this.placeComponents(order, compOf);
    this.routeRemainingLinks(links);
    this.refineRoutes(links);
    this.commitResults(diagram, links);
    diagram.commitTransaction('SwimLaneCompactLayout');
    this.resetState();
  }

  /**
   * @hidden @internal
   * Clears all per-run working state.
   */
  private resetState(): void {
    this._info = new Map();
    this._infos = [];
    this._lanes = [];
    this._grid = [];
    this._hUse = new Map();
    this._vUse = new Map();
    this._edgeShape = new Map();
    this._routeRec = new Map();
    this._sideOut = new Map();
    this._maxCol = 0;
  }

  /**
   * Given a Node, get the lane (name) that it belongs in.
   * If the lane appears to be undefined, this returns the empty string.
   */
  protected getLane(n: go.Node): string {
    const data = n.data;
    if (data === null) return '';
    let lane = null;
    if (typeof this.laneProperty === 'function') lane = this.laneProperty(data);
    else lane = data[this.laneProperty];
    return typeof lane === 'string' ? lane : '';
  }

  /**
   * @hidden @internal
   */
  private infoFor(n: go.Node | null): LaneNodeInfo | undefined {
    return n === null ? undefined : this._info.get(n);
  }

  /**
   * @hidden @internal
   */
  private edgeKeyOf(a: LaneNodeInfo, b: LaneNodeInfo): number {
    return a.idx * this._infos.length + b.idx;
  }

  /**
   * @hidden @internal
   * Collects nodes and links from the collection, discovers lanes, and builds
   * the working graph of LaneNodeInfo records. Returns the collected links.
   */
  private collectGraph(coll: go.Diagram | go.Group | go.Iterable<go.Part>): Array<go.Link> {
    const parts = this.collectParts(coll);
    const nodes: Array<go.Node> = [];
    const links: Array<go.Link> = [];
    parts.each((p) => {
      if (p instanceof go.Link) links.push(p);
      // else if (p instanceof go.Group) return;
      else if (p instanceof go.Node) nodes.push(p);
    });

    const laneNames = this.laneNames;
    const seen = new Set(laneNames);
    const laneOf = new Map<go.Node, string>();
    nodes.forEach((n) => {
      const l = this.getLane(n);
      laneOf.set(n, l);
      if (!seen.has(l)) {
        seen.add(l);
        laneNames.push(l);
      }
    });
    if (typeof this.laneComparer === 'function') laneNames.sort(this.laneComparer);
    const lanes = laneNames.slice();
    this._lanes = lanes;
    this._grid = lanes.map(() => []);
    if (lanes.length === 0) return links;
    const laneRow = new Map<string, number>();
    lanes.forEach((l, i) => laneRow.set(l, i));

    nodes.forEach((n) =>
      this._info.set(n, {
        node: n,
        row: laneRow.get(laneOf.get(n)!) ?? 0,
        col: -1,
        lcol: -1,
        idx: 0,
        indeg: 0,
        preds: [],
        succs: [],
        u0: 0,
        u1: 0,
        v0: 0,
        v1: 0
      })
    );
    links.forEach((l) => {
      const f = l.fromNode;
      const t = l.toNode;
      if (!f || !t || f === t) return;
      const fi = this._info.get(f);
      const ti = this._info.get(t);
      if (!fi || !ti) return;
      fi.succs.push(ti);
      ti.preds.push(fi);
      ti.indeg++;
    });
    this._info.forEach((v) => this._infos.push(v));
    this._infos.forEach((v, vi) => (v.idx = vi));
    return links;
  }

  /**
   * @hidden @internal
   * Tarjan's strongly-connected-components algorithm. Every cycle in the graph
   * lies entirely inside one of the returned groups.
   */
  private findSCCs(list: Array<LaneNodeInfo>): Array<Array<LaneNodeInfo>> {
    let idx = 0;
    const stack: Array<LaneNodeInfo> = [];
    const result: Array<Array<LaneNodeInfo>> = [];
    const meta = new Map<LaneNodeInfo, { index: number; low: number; onStack: boolean }>();
    function strong(v: LaneNodeInfo): void {
      const mv = { index: idx, low: idx, onStack: true };
      idx++;
      meta.set(v, mv);
      stack.push(v);
      v.succs.forEach((w) => {
        const mw = meta.get(w);
        if (mw === undefined) {
          strong(w);
          mv.low = Math.min(mv.low, meta.get(w)!.low);
        } else if (mw.onStack) {
          mv.low = Math.min(mv.low, mw.index);
        }
      });
      if (mv.low === mv.index) {
        const members: Array<LaneNodeInfo> = [];
        let w2: LaneNodeInfo;
        do {
          w2 = stack.pop()!;
          meta.get(w2)!.onStack = false;
          members.push(w2);
        } while (w2 !== v);
        result.push(members);
      }
    }
    list.forEach((v) => {
      if (!meta.has(v)) strong(v);
    });
    return result;
  }

  /**
   * @hidden @internal
   * Arranges a block's members into local columns (member.lcol). Small blocks
   * are solved exhaustively by {@link searchBlockLayout}; bigger blocks fall
   * back to greedy column rules whose forced cycle break prefers a member with
   * external preds, so the block reads left-to-right from where the outside
   * flow enters it.
   */
  private layoutBlock(members: Array<LaneNodeInfo>): void {
    if (members.length <= 6 && this.searchBlockLayout(members)) return;
    const cols = this.greedyBlockCols(members);
    members.forEach((m, i) => (m.lcol = cols[i]));
  }

  /**
   * @hidden @internal
   * Greedy block arrangement, used directly for blocks too big to search and
   * as the seed bound for the exhaustive search. Members are taken in local
   * topological order (cycles broken by fewest local preds, preferring members
   * with external preds so the block reads left-to-right from where the outside
   * flow enters it) and each takes the first free column in its lane that
   * satisfies its already-placed predecessors. Returns local columns parallel
   * to the members Array.
   */
  private greedyBlockCols(members: Array<LaneNodeInfo>): Array<number> {
    const mset = new Set(members);
    const localIndeg = new Map<LaneNodeInfo, number>();
    members.forEach((m) => localIndeg.set(m, m.preds.filter((p) => mset.has(p)).length));
    const lorder: Array<LaneNodeInfo> = [];
    const lrem = members.slice();
    while (lorder.length < members.length) {
      let ready = lrem.filter((m) => (localIndeg.get(m) ?? 0) <= 0);
      if (ready.length === 0) {
        lrem.sort((a, b) => {
          const d = (localIndeg.get(a) ?? 0) - (localIndeg.get(b) ?? 0);
          if (d !== 0) return d;
          const ea = a.preds.some((p) => !mset.has(p)) ? 0 : 1;
          const eb = b.preds.some((p) => !mset.has(p)) ? 0 : 1;
          return ea - eb;
        });
        ready = [lrem[0]];
      }
      const m = ready[0];
      lrem.splice(lrem.indexOf(m), 1);
      lorder.push(m);
      m.succs.forEach((s) => {
        if (mset.has(s)) localIndeg.set(s, (localIndeg.get(s) ?? 0) - 1);
      });
    }
    const assigned = new Map<LaneNodeInfo, number>();
    const occ = new Set<number>();
    lorder.forEach((m) => {
      let lc = 0;
      m.preds.forEach((p) => {
        const plc = assigned.get(p);
        if (plc === undefined) return;
        const need = p.row === m.row ? plc + 1 : plc;
        if (need > lc) lc = need;
      });
      while (occ.has(this.cellKey(m.row, lc))) lc++;
      assigned.set(m, lc);
      occ.add(this.cellKey(m.row, lc));
    });
    return members.map((m) => assigned.get(m)!);
  }

  /**
   * @hidden @internal
   * Exhaustive block arrangement: every lane-valid column assignment is scored
   * by routing all the internal edges (back edges included) on a scratch grid —
   * blocked routes cost heavily, flow-forward edges pointing leftward cost,
   * overlaps cost, width and spread break ties. Scoring reuses scratch
   * structures with packed-number keys so it allocates nothing per assignment,
   * and the recursion is branch-and-bound: partial assignments are abandoned
   * when the monotone score terms already cannot beat the best found, so the
   * result is identical to full enumeration.
   */
  private searchBlockLayout(members: Array<LaneNodeInfo>): boolean {
    const n = members.length;
    const mset = new Set(members);
    const rows = members.map((m) => m.row);
    const edges: Array<[number, number]> = [];
    members.forEach((m, i) => {
      m.succs.forEach((s) => {
        if (!mset.has(s) || s === m) return;
        edges.push([i, members.indexOf(s)]);
      });
    });
    // flow depths via BFS from the members the outside flow enters at; edges
    // that go deeper must not point leftward, only true loop returns may
    let entries = members.filter((m) => m.preds.some((p) => !mset.has(p)));
    if (entries.length === 0) entries = members.filter((m) => m.succs.some((s) => !mset.has(s)));
    if (entries.length === 0) entries = [members[0]];
    const depth = new Map<LaneNodeInfo, number>();
    const bfs = entries.slice();
    entries.forEach((m) => depth.set(m, 0));
    while (bfs.length > 0) {
      const cur2 = bfs.shift()!;
      cur2.succs.forEach((s) => {
        if (!mset.has(s) || depth.has(s)) return;
        depth.set(s, (depth.get(cur2) ?? 0) + 1);
        bfs.push(s);
      });
    }
    const edgeFlow = edges.map(
      (e2) => (depth.get(members[e2[1]]) ?? 0) > (depth.get(members[e2[0]]) ?? 0)
    );
    // edges grouped by their later-assigned endpoint, so flow violations can
    // accumulate incrementally while the recursion places members
    const edgesByMax: Array<Array<number>> = [];
    for (let i2 = 0; i2 < n; i2++) edgesByMax.push([]);
    edges.forEach((e2, ei) => {
      edgesByMax[Math.max(e2[0], e2[1])].push(ei);
    });
    // provable score floor: zero violations/flow/overlap, tightest lane packing;
    // once an assignment reaches it, nothing can beat it
    const lanePop = new Map<number, number>();
    rows.forEach((r2) => lanePop.set(r2, (lanePop.get(r2) ?? 0) + 1));
    let floorScore = 0;
    let maxPerLane = 1;
    lanePop.forEach((cnt) => {
      if (cnt > maxPerLane) maxPerLane = cnt;
      floorScore += (cnt * (cnt - 1)) / 2;
    });
    floorScore += maxPerLane * 50;

    const BPK = 512;
    const occ = new Set<number>();
    const hSet = new Map<number, number>();
    const vSet = new Map<number, number>();
    const hA: Array<number> = [];
    const vA: Array<number> = [];
    const hB: Array<number> = [];
    const vB: Array<number> = [];
    function shapeCost(
      fr: number,
      fc: number,
      tr: number,
      tc: number,
      shape: string,
      h: Array<number>,
      v: Array<number>
    ): number {
      h.length = 0;
      v.length = 0;
      let cc, rr, b;
      const lo = Math.min(fr, tr);
      const hi = Math.max(fr, tr);
      if (fr === tr) {
        if (shape !== 'H') return -1;
        for (cc = fc + 1; cc < tc; cc++) {
          if (occ.has(fr * BPK + cc)) return -1;
          h.push(fr * BPK + cc);
        }
      } else if (tc === fc || shape === 'H') {
        if (shape !== 'H') return -1;
        for (cc = fc + 1; cc <= tc; cc++) {
          if (occ.has(fr * BPK + cc)) return -1;
          h.push(fr * BPK + cc);
        }
        for (rr = lo + 1; rr < hi; rr++) {
          if (occ.has(rr * BPK + tc)) return -1;
        }
        for (b = lo; b < hi; b++) v.push(tc * BPK + b);
      } else {
        for (rr = lo + 1; rr < hi; rr++) {
          if (occ.has(rr * BPK + fc)) return -1;
        }
        for (b = lo; b < hi; b++) v.push(fc * BPK + b);
        for (cc = fc; cc < tc; cc++) {
          if (occ.has(tr * BPK + cc)) return -1;
          h.push(tr * BPK + cc);
        }
      }
      let cost = 0;
      for (let k2 = 0; k2 < h.length; k2++) cost += hSet.get(h[k2]) ?? 0;
      for (let k2 = 0; k2 < v.length; k2++) cost += vSet.get(v[k2]) ?? 0;
      return cost;
    }
    const cols: Array<number> = new Array(n).fill(0);
    let bestScore = Infinity;
    let bestCols: Array<number> | null = null;
    function scoreAssignment(limit: number): number {
      occ.clear();
      hSet.clear();
      vSet.clear();
      let i;
      for (i = 0; i < n; i++) occ.add(rows[i] * BPK + cols[i]);
      let total = 0;
      let violations = 0;
      let flowBad = 0;
      for (let ei = 0; ei < edges.length; ei++) {
        const e2 = edges[ei];
        let fr = rows[e2[0]];
        let fc = cols[e2[0]];
        let tr = rows[e2[1]];
        let tc = cols[e2[1]];
        if (edgeFlow[ei] && tc < fc) flowBad++;
        if (tc < fc) {
          let t2 = fr;
          fr = tr;
          tr = t2;
          t2 = fc;
          fc = tc;
          tc = t2;
        }
        const a = shapeCost(fr, fc, tr, tc, 'H', hA, vA);
        const b2 = fr !== tr && tc > fc ? shapeCost(fr, fc, tr, tc, 'V', hB, vB) : -1;
        if (a < 0 && b2 < 0) {
          violations++;
        } else {
          const useB = a < 0 || (b2 >= 0 && b2 < a);
          const ch = useB ? hB : hA;
          const cv = useB ? vB : vA;
          total += useB ? b2 : a;
          for (let k2 = 0; k2 < ch.length; k2++) hSet.set(ch[k2], (hSet.get(ch[k2]) ?? 0) + 1);
          for (let k2 = 0; k2 < cv.length; k2++) vSet.set(cv[k2], (vSet.get(cv[k2]) ?? 0) + 1);
        }
        if (violations * 100000 + flowBad * 5000 + total * 1000 >= limit) return Infinity;
      }
      let width = 0;
      let colSum = 0;
      for (i = 0; i < n; i++) {
        if (cols[i] + 1 > width) width = cols[i] + 1;
        colSum += cols[i];
      }
      return violations * 100000 + flowBad * 5000 + total * 1000 + width * 50 + colSum;
    }
    // Branch-and-bound over the tree itself: partial assignments are abandoned
    // when the monotone score terms (flow violations among fully-assigned
    // edges, width, column spread) already cannot beat the best found. The
    // canonical shift rule (some member must sit at column 0) is enforced on
    // the last member instead of filtering leaves, and per-lane column masks
    // replace a pairwise clash scan. All pruning is admissible.
    const laneMasks: Array<number> = [];
    let done = false;
    function rec(
      i: number,
      flowPartial: number,
      colSum: number,
      maxColSoFar: number,
      usedZero: boolean
    ): void {
      if (done) return;
      if (flowPartial * 5000 + (maxColSoFar + 1) * 50 + colSum >= bestScore) return;
      if (i === n) {
        const s = scoreAssignment(bestScore);
        if (s < bestScore) {
          bestScore = s;
          bestCols = cols.slice();
          if (bestScore <= floorScore) done = true;
        }
        return;
      }
      const row2 = rows[i];
      const mask = laneMasks[row2] | 0;
      const lastMustZero = !usedZero && i === n - 1;
      for (let c2 = 0; c2 < n; c2++) {
        if (lastMustZero && c2 !== 0) break;
        if ((mask >> c2) & 1) continue;
        cols[i] = c2;
        laneMasks[row2] = mask | (1 << c2);
        let fp = flowPartial;
        const closing = edgesByMax[i];
        for (let k2 = 0; k2 < closing.length; k2++) {
          const ei = closing[k2];
          if (edgeFlow[ei] && cols[edges[ei][1]] < cols[edges[ei][0]]) fp++;
        }
        rec(i + 1, fp, colSum + c2, c2 > maxColSoFar ? c2 : maxColSoFar, usedZero || c2 === 0);
        laneMasks[row2] = mask;
        if (done) return;
      }
    }
    // seed the bound with the greedy arrangement when it lies inside the
    // searched space (all columns < n). The result is provably unchanged: the
    // first enumeration-order assignment attaining the minimum scores below
    // the seed of greedy+1, is never pruned (all bounds are admissible), and
    // so still replaces the seed — but pruning starts tight instead of at
    // Infinity, which is what tames the large-block search times.
    const greedy = this.greedyBlockCols(members);
    if (Math.max(...greedy) < n) {
      for (let gi = 0; gi < n; gi++) cols[gi] = greedy[gi];
      bestScore = scoreAssignment(Infinity) + 1;
      bestCols = greedy;
    }
    rec(0, 0, 0, -1, false);
    if (bestCols === null) return false;
    const chosen: Array<number> = bestCols;
    members.forEach((m, i3) => (m.lcol = chosen[i3]));
    return true;
  }

  /**
   * @hidden @internal
   * Builds the component list. With {@link cycleBlocks} on, every strongly
   * connected component of acceptable size becomes a block that lays out
   * internally and places as one unit; the component graph is then a DAG.
   * With it off, every node is its own component. Components are sorted by
   * their smallest node index so both modes behave identically on acyclic graphs.
   */
  private buildComponents(compOf: Map<LaneNodeInfo, LaneComponent>): Array<LaneComponent> {
    this._infos.forEach((i) => (i.lcol = -1));
    const sccsRaw = this.cycleBlocks ? this.findSCCs(this._infos) : this._infos.map((i) => [i]);
    const sccs: Array<Array<LaneNodeInfo>> = [];
    sccsRaw.forEach((members) => {
      if (members.length > this.maxCycleBlockSize) members.forEach((m) => sccs.push([m]));
      else sccs.push(members);
    });
    const comps: Array<LaneComponent> = sccs.map((members) => {
      const comp: LaneComponent = {
        members: members,
        preds: [],
        succs: [],
        indeg: 0,
        rowMin: Infinity,
        rowMax: -Infinity,
        width: 1,
        minIdx: Infinity
      };
      members.forEach((m) => compOf.set(m, comp));
      return comp;
    });
    comps.forEach((comp) => {
      if (comp.members.length > 1) this.layoutBlock(comp.members);
      else comp.members[0].lcol = 0;
      comp.members.forEach((m) => {
        if (m.row < comp.rowMin) comp.rowMin = m.row;
        if (m.row > comp.rowMax) comp.rowMax = m.row;
        if (m.lcol + 1 > comp.width) comp.width = m.lcol + 1;
        if (m.idx < comp.minIdx) comp.minIdx = m.idx;
      });
    });
    comps.sort((a, b) => a.minIdx - b.minIdx);
    this._infos.forEach((fi) => {
      fi.succs.forEach((ti) => {
        const cf = compOf.get(fi)!;
        const ct = compOf.get(ti)!;
        if (cf === ct) return;
        cf.succs.push(ct);
        ct.preds.push(cf);
        ct.indeg++;
      });
    });
    return comps;
  }

  /**
   * @hidden @internal
   * BFS/flow placement order: components join the queue the moment they become
   * ready (ties within a batch broken by lane then model order) and are never
   * re-sorted afterwards — placing nearer-in-flow components first keeps them
   * from being walled in by deeper ones. Loose components go last, and cycles
   * among components (only possible with cycleBlocks off) are broken by forcing
   * the component with the fewest unplaced predecessors.
   */
  private orderComponents(comps: Array<LaneComponent>): Array<LaneComponent> {
    const order: Array<LaneComponent> = [];
    const indeg = new Map<LaneComponent, number>();
    const loose: Array<LaneComponent> = [];
    let remaining: Array<LaneComponent> = [];
    comps.forEach((c) => {
      indeg.set(c, c.indeg);
      (c.preds.length + c.succs.length === 0 ? loose : remaining).push(c);
    });
    const queue: Array<LaneComponent> = [];
    function promoteReady(): void {
      const still: Array<LaneComponent> = [];
      const batch: Array<LaneComponent> = [];
      remaining.forEach((c) => ((indeg.get(c) ?? 0) <= 0 ? batch : still).push(c));
      remaining = still;
      batch.sort((a, b) => (a.rowMin !== b.rowMin ? a.rowMin - b.rowMin : a.minIdx - b.minIdx));
      batch.forEach((c) => queue.push(c));
    }
    promoteReady();
    while (order.length + loose.length < comps.length) {
      if (queue.length === 0) {
        remaining.sort((a, b) => (indeg.get(a) ?? 0) - (indeg.get(b) ?? 0) || a.minIdx - b.minIdx);
        queue.push(remaining.shift()!);
      }
      const cur = queue.shift()!;
      order.push(cur);
      cur.succs.forEach((s) => indeg.set(s, (indeg.get(s) ?? 0) - 1));
      promoteReady();
    }
    loose.sort((a, b) => a.rowMin - b.rowMin || a.minIdx - b.minIdx);
    loose.forEach((c) => order.push(c));
    return order;
  }

  /**
   * @hidden @internal
   * Packed key for the grid cell at (row, col).
   */
  private cellKey(r: number, c: number): number {
    return r * SwimLaneCompactLayout.PK + c;
  }

  /**
   * @hidden @internal
   * Packed key for the lane boundary below row b, crossed while traveling in column c.
   */
  private segKey(c: number, b: number): number {
    return c * SwimLaneCompactLayout.PK + b;
  }

  /**
   * @hidden @internal
   * Attempts one route shape between grid positions. Shapes: 'H' travels the
   * source lane first then the target column; 'V' travels the source column
   * first then the target lane; 'U'/'D' are same-lane detours arcing through
   * the lane above or below. All shapes work in either horizontal direction.
   * Node cells block; block-reserved cells add cost; co-traveling links cost
   * per shared horizontal cell or per shared vertical lane-boundary crossing,
   * while perpendicular crossings are free.
   */
  private tryRoute(
    pr: number,
    pc: number,
    r: number,
    c: number,
    shape: string,
    extraH: Set<number>,
    extraV: Set<number>
  ): LaneRoute | null {
    const grid = this._grid;
    const hUse = this._hUse;
    const vUse = this._vUse;
    const hCells: Array<number> = [];
    const vCells: Array<number> = [];
    const vSegs: Array<number> = [];
    let cost = 0;
    const lay = this;
    function hRun(row: number, c1: number, c2: number): boolean {
      for (let x = c1; x <= c2; x++) {
        const code = grid[row][x];
        if (code === 1) return false;
        if (code === 3) cost += 1;
        const key = lay.cellKey(row, x);
        hCells.push(key);
        cost += (hUse.get(key) ?? 0) + (extraH.has(key) ? 1 : 0);
      }
      return true;
    }
    function vRun(col: number, r1: number, r2: number): boolean {
      const lo = Math.min(r1, r2);
      const hi = Math.max(r1, r2);
      for (let x = lo + 1; x < hi; x++) {
        const code = grid[x][col];
        if (code === 1) return false;
        if (code === 3) cost += 1;
        vCells.push(lay.cellKey(x, col));
      }
      for (let b = lo; b < hi; b++) {
        const key = lay.segKey(col, b);
        vSegs.push(key);
        cost += (vUse.get(key) ?? 0) + (extraV.has(key) ? 1 : 0);
      }
      return true;
    }
    function done(shp: string): LaneRoute {
      return { hCells: hCells, vCells: vCells, vSegs: vSegs, cost: cost, shape: shp };
    }
    if (pr === r) {
      if (shape === 'H') {
        if (!hRun(pr, Math.min(pc, c) + 1, Math.max(pc, c) - 1)) return null;
        return done('flat');
      }
      if (shape === 'U' || shape === 'D') {
        const dr = shape === 'U' ? pr - 1 : pr + 1;
        if (dr < 0 || dr >= grid.length) return null;
        if (!vRun(pc, pr, dr)) return null;
        if (!hRun(dr, Math.min(pc, c), Math.max(pc, c))) return null;
        if (!vRun(c, dr, r)) return null;
        return done(shape === 'U' ? 'flatU' : 'flatD');
      }
      return null;
    }
    if (c === pc) {
      if (shape !== 'H') return null;
      if (!vRun(c, pr, r)) return null;
      return done('vert');
    }
    const forward = c > pc;
    if (shape === 'H') {
      if (!hRun(pr, forward ? pc + 1 : c, forward ? c : pc - 1)) return null;
      if (!vRun(c, pr, r)) return null;
      return done(forward ? 'H' : 'HL');
    }
    if (shape === 'V') {
      if (!vRun(pc, pr, r)) return null;
      if (!hRun(r, forward ? pc : c + 1, forward ? c - 1 : pc)) return null;
      return done(forward ? 'V' : 'VL');
    }
    return null;
  }

  /**
   * @hidden @internal
   * Tries every shape applicable to the pair of positions and returns the cheapest.
   */
  private bestRoute(
    pr: number,
    pc: number,
    r: number,
    c: number,
    extraH: Set<number>,
    extraV: Set<number>
  ): LaneRoute | null {
    const shapes =
      pr === r
        ? SwimLaneCompactLayout.SHAPES_SAME_LANE
        : c === pc
          ? SwimLaneCompactLayout.SHAPES_SAME_COL
          : SwimLaneCompactLayout.SHAPES_CROSS;
    let pick: LaneRoute | null = null;
    for (let i = 0; i < shapes.length; i++) {
      const rt = this.tryRoute(pr, pc, r, c, shapes[i], extraH, extraV);
      if (rt !== null && (pick === null || rt.cost < pick.cost)) pick = rt;
    }
    return pick;
  }

  /**
   * @hidden @internal
   * Which side of the source node a route shape exits from.
   */
  private exitSideOf(shape: string, fi: LaneNodeInfo, ti: LaneNodeInfo): string {
    if (shape === 'flat') return ti.col > fi.col ? 'R' : 'L';
    if (shape === 'flatU') return 'T';
    if (shape === 'flatD') return 'B';
    if (shape === 'H') return 'R';
    if (shape === 'HL') return 'L';
    return ti.row > fi.row ? 'B' : 'T';
  }

  /**
   * @hidden @internal
   * Records a winning route everywhere it matters: corridor cells on the grid
   * (so future nodes keep out), the traffic maps (so future routes pay for
   * co-travel), the route/shape records (so refinement can undo it), and the
   * per-side target sets feeding the port-congestion cost.
   */
  private claimRoute(rt: LaneRoute, fromInfo: LaneNodeInfo, toInfo: LaneNodeInfo): void {
    const grid = this._grid;
    rt.hCells.forEach((cell) => {
      // unpack the cell key back into (row, col) for the grid write
      const cr = (cell / SwimLaneCompactLayout.PK) | 0;
      const cc = cell % SwimLaneCompactLayout.PK;
      if (grid[cr][cc] === undefined) grid[cr][cc] = 2;
      this._hUse.set(cell, (this._hUse.get(cell) ?? 0) + 1);
    });
    rt.vCells.forEach((cell) => {
      const cr = (cell / SwimLaneCompactLayout.PK) | 0;
      const cc = cell % SwimLaneCompactLayout.PK;
      if (grid[cr][cc] === undefined) grid[cr][cc] = 2;
    });
    rt.vSegs.forEach((s) => this._vUse.set(s, (this._vUse.get(s) ?? 0) + 1));
    this._edgeShape.set(this.edgeKeyOf(fromInfo, toInfo), rt.shape);
    this._routeRec.set(this.edgeKeyOf(fromInfo, toInfo), rt);
    const sk = String(fromInfo.node.key) + '|' + this.exitSideOf(rt.shape, fromInfo, toInfo);
    let st = this._sideOut.get(sk);
    if (!st) {
      st = new Set();
      this._sideOut.set(sk, st);
    }
    st.add(String(toInfo.node.key));
  }

  /**
   * @hidden @internal
   * Reverses a route's traffic and side records. Corridor cells on the grid are
   * deliberately left in place: by refinement time all nodes are placed, so
   * they can no longer influence anything.
   */
  private unclaimRoute(rt: LaneRoute, fromInfo: LaneNodeInfo, toInfo: LaneNodeInfo): void {
    rt.hCells.forEach((cell) => this._hUse.set(cell, (this._hUse.get(cell) ?? 1) - 1));
    rt.vSegs.forEach((s) => this._vUse.set(s, (this._vUse.get(s) ?? 1) - 1));
    const st = this._sideOut.get(
      String(fromInfo.node.key) + '|' + this.exitSideOf(rt.shape, fromInfo, toInfo)
    );
    if (st) st.delete(String(toInfo.node.key));
  }

  /**
   * @hidden @internal
   * Places every component. A component places like a fat node: its whole
   * footprint rectangle must be free and gets reserved — member cells as nodes,
   * the leftover cells as protected corridor space for the block's internal
   * back links. Column choice is best-effort: the first base column with zero
   * violated predecessor routes, else the fewest within a bounded window.
   * Predecessor edges closest to their target column route first so straight
   * vertical drops claim their channel before L-shapes pick a side.
   */
  private placeComponents(order: Array<LaneComponent>, compOf: Map<LaneNodeInfo, LaneComponent>): void {
    const grid = this._grid;
    order.forEach((comp) => {
      const predEdges: Array<PredEdge> = [];
      comp.members.forEach((m) => {
        m.preds.forEach((p) => {
          if (compOf.get(p) !== comp && p.col >= 0) predEdges.push({ p: p, m: m });
        });
      });
      let minBase = 0;
      predEdges.forEach((e) => {
        const need = (e.p.row === e.m.row ? e.p.col + 1 : e.p.col) - e.m.lcol;
        if (need > minBase) minBase = need;
      });
      let best: {
        base: number;
        violations: number;
        routes: Array<{ e: PredEdge; rt: LaneRoute }>;
      } | null = null;
      let base = minBase;
      for (let guard = 0; guard < 10000; guard++, base++) {
        let free = true;
        for (let fr = comp.rowMin; fr <= comp.rowMax && free; fr++) {
          for (let fw = 0; fw < comp.width; fw++) {
            if (grid[fr][base + fw] !== undefined) {
              free = false;
              break;
            }
          }
        }
        if (!free) continue;
        comp.members.forEach((m) => (grid[m.row][base + m.lcol] = 1));
        for (let mr = comp.rowMin; mr <= comp.rowMax; mr++) {
          for (let mw = 0; mw < comp.width; mw++) {
            if (grid[mr][base + mw] === undefined) grid[mr][base + mw] = 3;
          }
        }
        const routes: Array<{ e: PredEdge; rt: LaneRoute }> = [];
        let violations = 0;
        const extraH = new Set<number>();
        const extraV = new Set<number>();
        const bb = base;
        const sorted = predEdges
          .slice()
          .sort((a, b) => Math.abs(a.p.col - (bb + a.m.lcol)) - Math.abs(b.p.col - (bb + b.m.lcol)));
        for (let k = 0; k < sorted.length; k++) {
          // violations only grow, so a base already no better than the best cannot win
          if (best !== null && violations >= best.violations) break;
          const e = sorted[k];
          const tc = base + e.m.lcol;
          const rt = this.bestRoute(e.p.row, e.p.col, e.m.row, tc, extraH, extraV);
          if (rt === null) {
            violations++;
            continue;
          }
          routes.push({ e: e, rt: rt });
          rt.hCells.forEach((cell) => extraH.add(cell));
          rt.vSegs.forEach((s) => extraV.add(s));
        }
        for (let ur = comp.rowMin; ur <= comp.rowMax; ur++) {
          for (let uw = 0; uw < comp.width; uw++) {
            if (grid[ur][base + uw] === 1 || grid[ur][base + uw] === 3) grid[ur][base + uw] = undefined;
          }
        }
        if (best === null || violations < best.violations) {
          best = { base: base, violations: violations, routes: routes };
        }
        if (best.violations === 0 || base > minBase + this._maxCol + this._infos.length + 2) break;
      }
      if (best === null) best = { base: base, violations: 0, routes: [] };
      const chosenBase = best.base;
      comp.members.forEach((m) => {
        m.col = chosenBase + m.lcol;
        grid[m.row][m.col] = 1;
        if (m.col > this._maxCol) this._maxCol = m.col;
      });
      for (let rr2 = comp.rowMin; rr2 <= comp.rowMax; rr2++) {
        for (let ww2 = 0; ww2 < comp.width; ww2++) {
          if (grid[rr2][chosenBase + ww2] === undefined) grid[rr2][chosenBase + ww2] = 3;
        }
      }
      best.routes.forEach((entry) => this.claimRoute(entry.rt, entry.e.p, entry.e.m));
      if (comp.members.length > 1) {
        const mset = new Set(comp.members);
        comp.members.forEach((m) => {
          m.succs.forEach((s) => {
            if (!mset.has(s)) return;
            if (this._edgeShape.has(this.edgeKeyOf(m, s))) return;
            const rt2 = this.bestRoute(
              m.row,
              m.col,
              s.row,
              s.col,
              SwimLaneCompactLayout.NO_EXTRA,
              SwimLaneCompactLayout.NO_EXTRA
            );
            if (rt2 !== null) this.claimRoute(rt2, m, s);
          });
        });
      }
    });
  }

  /**
   * @hidden @internal
   * Routes everything still unrouted after placement (back links, previously
   * blocked links) through the free space and reserved corridors the layout
   * left open.
   */
  private routeRemainingLinks(links: Array<go.Link>): void {
    links.forEach((l) => {
      const lf = this.infoFor(l.fromNode);
      const lt = this.infoFor(l.toNode);
      if (!lf || !lt || lf === lt) return;
      if (this._edgeShape.has(this.edgeKeyOf(lf, lt))) return;
      const lrt = this.bestRoute(
        lf.row,
        lf.col,
        lt.row,
        lt.col,
        SwimLaneCompactLayout.NO_EXTRA,
        SwimLaneCompactLayout.NO_EXTRA
      );
      if (lrt !== null) this.claimRoute(lrt, lf, lt);
    });
  }

  /**
   * @hidden @internal
   * Re-evaluates one link's route against the complete picture. Beyond the
   * overlap costs, exiting a side of the source that other links to different
   * targets already use costs extra, so a Yes/No pair fans out of different
   * ports while links converging on one target may share a channel.
   */
  private rerouteEdge(fi: LaneNodeInfo, ti: LaneNodeInfo): LaneRoute | null {
    const shapes =
      fi.row === ti.row
        ? SwimLaneCompactLayout.SHAPES_SAME_LANE
        : ti.col === fi.col
          ? SwimLaneCompactLayout.SHAPES_SAME_COL
          : SwimLaneCompactLayout.SHAPES_CROSS;
    let pick: LaneRoute | null = null;
    for (let si = 0; si < shapes.length; si++) {
      const rt2 = this.tryRoute(
        fi.row,
        fi.col,
        ti.row,
        ti.col,
        shapes[si],
        SwimLaneCompactLayout.NO_EXTRA,
        SwimLaneCompactLayout.NO_EXTRA
      );
      if (rt2 === null) continue;
      const others = this._sideOut.get(String(fi.node.key) + '|' + this.exitSideOf(rt2.shape, fi, ti));
      if (others) {
        others.forEach((t2) => {
          if (t2 !== String(ti.node.key)) rt2.cost += 2;
        });
      }
      if (pick === null || rt2.cost < pick.cost) pick = rt2;
    }
    return pick;
  }

  /**
   * @hidden @internal
   * Runs two passes in which every link releases its claims, re-routes with
   * full knowledge, and re-claims the best shape.
   * A route is fully determined by its endpoints and shape, so a sweep in
   * which no link changed shape left the state exactly as it found it —
   * every later sweep would be a no-op and the loop stops early.
   */
  private refineRoutes(links: Array<go.Link>): void {
    for (let sweep = 0; sweep < 2; sweep++) {
      let changed = false;
      links.forEach((l) => {
        const sf = this.infoFor(l.fromNode);
        const st2 = this.infoFor(l.toNode);
        if (!sf || !st2 || sf === st2) return;
        const old = this._routeRec.get(this.edgeKeyOf(sf, st2));
        if (!old) return;
        this.unclaimRoute(old, sf, st2);
        const next = this.rerouteEdge(sf, st2);
        if (next !== null && next.shape !== old.shape) changed = true;
        this.claimRoute(next !== null ? next : old, sf, st2);
      });
      if (!changed) break;
    }
  }

  /**
   * @hidden @internal
   * Maps a point from abstract layout coordinates (u along the flow direction,
   * v across the lanes) into document coordinates according to {@link direction}.
   */
  private mapPoint(u: number, v: number, totalU: number): go.Point {
    const o = this.arrangementOrigin;
    switch (this._direction) {
      case 90:
        return new go.Point(o.x + v, o.y + u);
      case 180:
        return new go.Point(o.x + totalU - u, o.y + v);
      case 270:
        return new go.Point(o.x + v, o.y + totalU - u);
      default:
        return new go.Point(o.x + u, o.y + v);
    }
  }

  /**
   * @hidden @internal
   * Maps a spot chosen in abstract layout terms (Right = forward along the flow,
   * Bottom = toward higher lane index) into the document-coordinate side that
   * direction actually faces, according to {@link direction}.
   */
  private mapSpot(s: go.Spot): go.Spot {
    const dir = this._direction;
    if (dir === 0) return s;
    if (dir === 180) {
      if (s.equals(go.Spot.Right)) return go.Spot.Left;
      if (s.equals(go.Spot.Left)) return go.Spot.Right;
      return s;
    }
    if (s.equals(go.Spot.Right)) return dir === 90 ? go.Spot.Bottom : go.Spot.Top;
    if (s.equals(go.Spot.Left)) return dir === 90 ? go.Spot.Top : go.Spot.Bottom;
    if (s.equals(go.Spot.Top)) return go.Spot.Left;
    return go.Spot.Right;
  }

  /**
   * @hidden @internal
   * Turns the finished grid into document coordinates inside one transaction:
   * columns size to their longest node along the flow axis and lanes to their
   * broadest across it, nodes center in their cells, link spots and explicit
   * route points are assigned, and the lane group bands are stretched across
   * the diagram. All geometry is computed in abstract flow/cross coordinates
   * and mapped through {@link mapPoint} so every {@link direction} shares the
   * same code path.
   */
  private commitResults(diagram: go.Diagram, links: Array<go.Link>): void {
    const lanes = this._lanes;
    const horiz = this._direction === 0 || this._direction === 180;
    const colExtent: Array<number> = [];
    let laneBreadth: Array<number> = lanes.map(() => 0);
    this._infos.forEach((ni) => {
      // a node that has never been positioned has NaN actualBounds, so give it a real
      // position first if necessary
      if (!ni.node.actualBounds.isReal()) {
        ni.node.moveTo(0, 0);
        ni.node.ensureBounds();
      }
      const b = this.getLayoutBounds(ni.node);
      colExtent[ni.col] = Math.max(colExtent[ni.col] || 0, horiz ? b.width : b.height);
      laneBreadth[ni.row] = Math.max(laneBreadth[ni.row], horiz ? b.height : b.width);
    });
    for (let c = 0; c <= this._maxCol; c++) {
      colExtent[c] = Math.max(colExtent[c] || 0, this.minColumnWidth);
    }
    laneBreadth = laneBreadth.map((h) => Math.max(h + 2 * this.lanePadding, this.minLaneHeight));

    const colU: Array<number> = [];
    let u = 0;
    for (let c = 0; c <= this._maxCol; c++) {
      colU[c] = u;
      u += colExtent[c] + this.layerSpacing;
    }
    const totalU = Math.max(u - this.layerSpacing, this.minColumnWidth);
    const laneV: Array<number> = [];
    let v = 0;
    laneBreadth.forEach((h, i) => {
      laneV[i] = v;
      v += h + this.laneSpacing;
    });

    this._infos.forEach((ni) => {
      const b = this.getLayoutBounds(ni.node);
      const cu = colU[ni.col] + colExtent[ni.col] / 2;
      const cv = laneV[ni.row] + laneBreadth[ni.row] / 2;
      const along = horiz ? b.width : b.height;
      const across = horiz ? b.height : b.width;
      ni.u0 = cu - along / 2;
      ni.u1 = cu + along / 2;
      ni.v0 = cv - across / 2;
      ni.v1 = cv + across / 2;
      const ctr = this.mapPoint(cu, cv, totalU);
      // b may describe an object inside the node (see boundsComputation), so shift by the
      // offset between the node's position and those bounds to center that object, not the node
      const nb = ni.node.actualBounds;
      ni.node.moveTo(ctr.x - b.width / 2 + (nb.x - b.x), ctr.y - b.height / 2 + (nb.y - b.y));
    });

    if (this.setsPortSpots) this.assignLinkSpots(links);
    if (this.setsRoutePoints) this.assignRoutePoints(links, colU, colExtent, laneV, laneBreadth, totalU);

    const origin = this.arrangementOrigin;
    const bandStart = -this.layerSpacing / 2;
    const bandLen = totalU + this.layerSpacing;
    lanes.forEach((lane, i) => {
      let group = diagram.findNodeForKey(lane);
      if (group === null) {
        diagram.model.addNodeData({ key: lane, isGroup: true });
        group = diagram.findNodeForKey(lane);
      }
      if (group === null) return;
      const ph = group.findObject('PLACEHOLDER');
      if (horiz) {
        if (ph !== null) ph.desiredSize = new go.Size(bandLen, laneBreadth[i]);
        group.location = new go.Point(origin.x + bandStart, origin.y + laneV[i]);
      } else {
        if (ph !== null) ph.desiredSize = new go.Size(laneBreadth[i], bandLen);
        group.location = new go.Point(origin.x + laneV[i], origin.y + bandStart);
      }
    });
  }

  /**
   * @hidden @internal
   * Assigns each link's spots to match its chosen corridor shape; links with no
   * corridor that travel backward enter the target's forward side, and anything
   * else keeps the template default. Spots are chosen in abstract flow terms and
   * mapped through {@link mapSpot} for the current {@link direction}.
   */
  private assignLinkSpots(links: Array<go.Link>): void {
    links.forEach((l) => {
      const fi = this.infoFor(l.fromNode);
      const ti = this.infoFor(l.toNode);
      if (!fi || !ti || fi === ti) return;
      const shape = this._edgeShape.get(this.edgeKeyOf(fi, ti));
      if (shape === 'flat') {
        l.fromSpot = this.mapSpot(ti.col > fi.col ? go.Spot.Right : go.Spot.Left);
        l.toSpot = this.mapSpot(ti.col > fi.col ? go.Spot.Left : go.Spot.Right);
      } else if (shape === 'flatU') {
        l.fromSpot = this.mapSpot(go.Spot.Top);
        l.toSpot = this.mapSpot(go.Spot.Top);
      } else if (shape === 'flatD') {
        l.fromSpot = this.mapSpot(go.Spot.Bottom);
        l.toSpot = this.mapSpot(go.Spot.Bottom);
      } else if (shape === 'vert') {
        l.fromSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Bottom : go.Spot.Top);
        l.toSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Top : go.Spot.Bottom);
      } else if (shape === 'H') {
        l.fromSpot = this.mapSpot(go.Spot.Right);
        l.toSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Top : go.Spot.Bottom);
      } else if (shape === 'HL') {
        l.fromSpot = this.mapSpot(go.Spot.Left);
        l.toSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Top : go.Spot.Bottom);
      } else if (shape === 'V') {
        l.fromSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Bottom : go.Spot.Top);
        l.toSpot = this.mapSpot(go.Spot.Left);
      } else if (shape === 'VL') {
        l.fromSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Bottom : go.Spot.Top);
        l.toSpot = this.mapSpot(go.Spot.Right);
      } else if (ti.col < fi.col) {
        l.fromSpot = this.mapSpot(ti.row > fi.row ? go.Spot.Bottom : go.Spot.Top);
        l.toSpot = this.mapSpot(go.Spot.Right);
      }
    });
  }

  /**
   * @hidden @internal
   * Converts each reserved corridor into the link's actual polyline, so the
   * drawn geometry matches the grid exactly and never cuts through nodes.
   * Runs sharing a channel fan out by {@link channelSpacing} via interval
   * partitioning per lane row and per column, clamped so endpoints stay on the
   * node edge. Links that never got a corridor route around nodes instead.
   */
  private assignRoutePoints(
    links: Array<go.Link>,
    colU: Array<number>,
    colExtent: Array<number>,
    laneV: Array<number>,
    laneBreadth: Array<number>,
    totalU: number
  ): void {
    const uOf = (c2: number): number => colU[c2] + colExtent[c2] / 2;
    const vOf = (r2: number): number => laneV[r2] + laneBreadth[r2] / 2;
    const hRunsByRow = new Map<number, Array<ChannelRun>>();
    const vRunsByCol = new Map<number, Array<ChannelRun>>();
    function regRun(
      map: Map<number, Array<ChannelRun>>,
      mkey: number,
      a: number,
      b2: number,
      maxOff: number
    ): ChannelRun {
      const run: ChannelRun = {
        lo: Math.min(a, b2),
        hi: Math.max(a, b2),
        off: 0,
        max: Math.max(0, maxOff)
      };
      let arr = map.get(mkey);
      if (!arr) {
        arr = [];
        map.set(mkey, arr);
      }
      arr.push(run);
      return run;
    }
    const plans: Array<RoutePlan> = [];
    links.forEach((l) => {
      const fi = this.infoFor(l.fromNode);
      const ti = this.infoFor(l.toNode);
      if (!fi || !ti || fi === ti) return;
      const rt = this._routeRec.get(this.edgeKeyOf(fi, ti));
      if (!rt) {
        l.routing = go.Routing.AvoidsNodes;
        return;
      }
      const shape = rt.shape;
      const plan: RoutePlan = { link: l, shape: shape, fi: fi, ti: ti, h: null, v: null, v2: null };
      const down = ti.row > fi.row;
      if (shape === 'flat') {
        const fwd = ti.col > fi.col;
        plan.h = regRun(
          hRunsByRow,
          fi.row,
          fwd ? fi.u1 : ti.u1,
          fwd ? ti.u0 : fi.u0,
          Math.min(fi.v1 - fi.v0, ti.v1 - ti.v0) / 2 - 5
        );
      } else if (shape === 'vert') {
        plan.v = regRun(
          vRunsByCol,
          ti.col,
          down ? fi.v1 : ti.v1,
          down ? ti.v0 : fi.v0,
          Math.min(fi.u1 - fi.u0, ti.u1 - ti.u0) / 2 - 5
        );
      } else if (shape === 'H' || shape === 'HL') {
        plan.h = regRun(
          hRunsByRow,
          fi.row,
          shape === 'H' ? fi.u1 : fi.u0,
          uOf(ti.col),
          (fi.v1 - fi.v0) / 2 - 5
        );
        plan.v = regRun(
          vRunsByCol,
          ti.col,
          vOf(fi.row),
          down ? ti.v0 : ti.v1,
          (ti.u1 - ti.u0) / 2 - 5
        );
      } else if (shape === 'V' || shape === 'VL') {
        plan.v = regRun(
          vRunsByCol,
          fi.col,
          down ? fi.v1 : fi.v0,
          vOf(ti.row),
          (fi.u1 - fi.u0) / 2 - 5
        );
        plan.h = regRun(
          hRunsByRow,
          ti.row,
          uOf(fi.col),
          shape === 'V' ? ti.u0 : ti.u1,
          (ti.v1 - ti.v0) / 2 - 5
        );
      } else if (shape === 'flatU' || shape === 'flatD') {
        const dr = shape === 'flatU' ? fi.row - 1 : fi.row + 1;
        const vd = vOf(dr);
        plan.v = regRun(
          vRunsByCol,
          fi.col,
          shape === 'flatU' ? fi.v0 : fi.v1,
          vd,
          (fi.u1 - fi.u0) / 2 - 5
        );
        plan.v2 = regRun(
          vRunsByCol,
          ti.col,
          vd,
          shape === 'flatU' ? ti.v0 : ti.v1,
          (ti.u1 - ti.u0) / 2 - 5
        );
        plan.h = regRun(hRunsByRow, dr, uOf(fi.col), uOf(ti.col), laneBreadth[dr] / 2 - 6);
      } else {
        return;
      }
      plans.push(plan);
    });
    const spacing = this.channelSpacing;
    function assignChannelOffsets(map: Map<number, Array<ChannelRun>>): void {
      map.forEach((runs) => {
        runs.sort((a, b2) => a.lo - b2.lo || a.hi - b2.hi);
        const slots: Array<Array<ChannelRun>> = [];
        runs.forEach((run) => {
          let si = 0;
          for (; si < slots.length; si++) {
            const arr = slots[si];
            let ok = true;
            for (let k2 = 0; k2 < arr.length; k2++) {
              if (run.lo < arr[k2].hi - 0.5 && arr[k2].lo < run.hi - 0.5) {
                ok = false;
                break;
              }
            }
            if (ok) break;
          }
          if (si === slots.length) slots.push([]);
          slots[si].push(run);
          let off = (si % 2 === 1 ? 1 : -1) * Math.ceil(si / 2) * spacing;
          if (off > run.max) off = run.max;
          if (off < -run.max) off = -run.max;
          run.off = off;
        });
      });
    }
    assignChannelOffsets(hRunsByRow);
    assignChannelOffsets(vRunsByCol);
    plans.forEach((p) => {
      const fi = p.fi;
      const ti = p.ti;
      const down = ti.row > fi.row;
      const pts = new go.List<go.Point>();
      const shape = p.shape;
      if (shape === 'flat') {
        const pv = vOf(fi.row) + (p.h ? p.h.off : 0);
        if (ti.col > fi.col) {
          pts.add(this.mapPoint(fi.u1, pv, totalU));
          pts.add(this.mapPoint(ti.u0, pv, totalU));
        } else {
          pts.add(this.mapPoint(fi.u0, pv, totalU));
          pts.add(this.mapPoint(ti.u1, pv, totalU));
        }
      } else if (shape === 'vert') {
        const pu = uOf(ti.col) + (p.v ? p.v.off : 0);
        pts.add(this.mapPoint(pu, down ? fi.v1 : fi.v0, totalU));
        pts.add(this.mapPoint(pu, down ? ti.v0 : ti.v1, totalU));
      } else if (shape === 'H' || shape === 'HL') {
        const v1 = vOf(fi.row) + (p.h ? p.h.off : 0);
        const uv = uOf(ti.col) + (p.v ? p.v.off : 0);
        pts.add(this.mapPoint(shape === 'H' ? fi.u1 : fi.u0, v1, totalU));
        pts.add(this.mapPoint(uv, v1, totalU));
        pts.add(this.mapPoint(uv, down ? ti.v0 : ti.v1, totalU));
      } else if (shape === 'V' || shape === 'VL') {
        const uv = uOf(fi.col) + (p.v ? p.v.off : 0);
        const v2 = vOf(ti.row) + (p.h ? p.h.off : 0);
        pts.add(this.mapPoint(uv, down ? fi.v1 : fi.v0, totalU));
        pts.add(this.mapPoint(uv, v2, totalU));
        pts.add(this.mapPoint(shape === 'V' ? ti.u0 : ti.u1, v2, totalU));
      } else if (shape === 'flatU' || shape === 'flatD') {
        const dr = shape === 'flatU' ? fi.row - 1 : fi.row + 1;
        const vd = vOf(dr) + (p.h ? p.h.off : 0);
        const us = uOf(fi.col) + (p.v ? p.v.off : 0);
        const ut = uOf(ti.col) + (p.v2 ? p.v2.off : 0);
        const up = shape === 'flatU';
        pts.add(this.mapPoint(us, up ? fi.v0 : fi.v1, totalU));
        pts.add(this.mapPoint(us, vd, totalU));
        pts.add(this.mapPoint(ut, vd, totalU));
        pts.add(this.mapPoint(ut, up ? ti.v0 : ti.v1, totalU));
      } else {
        return;
      }
      p.link.points = pts;
    });
  }
} // end SwimLaneCompactLayout
