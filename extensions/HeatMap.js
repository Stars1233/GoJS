/*
 *  Copyright 1998-2026 by Northwoods Software Corporation. All Rights Reserved.
 */
/*
 * This is an extension and not part of the main GoJS library.
 * The source code for this is at extensionsJSM/HeatMap.ts.
 * Note that the API for this class may change with any version, even point releases.
 * If you intend to use an extension in production, you should copy the code to your own source directory.
 * Extensions can be found in the GoJS kit under the extensions or extensionsJSM folders.
 * See the Extensions learn page (https://gojs.net/learn/extensions) for more information.
 */

/**
 * This enumeration determines the distance metric by which heat spreads outward from a Part.
 * Used for {@link HeatMap.metric}.
 *
 * Note: this enumeration only exists in extensionsJSM, not in extensions.
 * @category Extension
 */
var HeatMapMetric;
(function (HeatMapMetric) {
    /**
     * Heat spreads by city-block distance, producing diamond-shaped halos.
     */
    HeatMapMetric[HeatMapMetric["Manhattan"] = 0] = "Manhattan";
    /**
     * Heat spreads by approximately Euclidean distance, producing approximately circular halos.
     */
    HeatMapMetric[HeatMapMetric["Euclidean"] = 1] = "Euclidean";
})(HeatMapMetric || (HeatMapMetric = {}));
/**
 * This enumeration determines the coordinate system in which heat spread distances are measured.
 * Used for {@link HeatMap.spreadUnits}.
 *
 * Note: this enumeration only exists in extensionsJSM, not in extensions.
 * @category Extension
 */
var HeatMapSpreadUnits;
(function (HeatMapSpreadUnits) {
    /**
     * Heat spreads a fixed number of canvas pixels regardless of the Diagram.scale,
     * one pixel per entry in {@link HeatMap.colors}.
     */
    HeatMapSpreadUnits[HeatMapSpreadUnits["Viewport"] = 0] = "Viewport";
    /**
     * Heat spreads a fixed distance in document coordinates, one document unit per entry
     * in {@link HeatMap.colors}, so halos scale together with Parts as the user zooms.
     */
    HeatMapSpreadUnits[HeatMapSpreadUnits["Document"] = 1] = "Document";
})(HeatMapSpreadUnits || (HeatMapSpreadUnits = {}));
/**
 * A class for drawing a heat map based on the "temperatures" of Parts.
 *
 * This class adds a heat map image in the "ViewportForeground" Layer
 * that is dynamically computed as the user scrolls or zooms or when
 * a transaction/undo/redo is finished.
 *
 * It also has a method, renderImageData, that renders a heat map for a given area of the document,
 * not just for the viewport, returning an ImageData.
 * @category Extension
 */
class HeatMap {
    /**
     * Construct a HeatMap for a Diagram, optionally setting some properties.
     * @param diag if not supplied, the {@link diagram} will be null
     * @param init
     */
    constructor(diag, init) {
        this._diagram = null;
        this._heatMapPart = new go.Part({
            layerName: 'ViewportForeground',
            alignment: go.Spot.TopLeft,
            alignmentFocus: go.Spot.TopLeft
        }).add(new go.Picture({ name: 'IMG', element: document.createElement('canvas') }));
        this._colors =
            // this forms the default gradient; this could be improved
            [
                // EACH ENTRY MUST BE DIFFERENT FROM DIFFERENT FROM EACH OTHER
                [0xff, 0x45, 0x00, 200], // orangered
                [0xff, 0x55, 0x00, 200],
                [0xff, 0x65, 0x00, 200],
                [0xff, 0x75, 0x00, 200],
                [0xff, 0x85, 0x00, 190],
                [0xff, 0x95, 0x00, 190],
                [0xff, 0xa5, 0x00, 190], // orange
                [0xff, 0xb5, 0x00, 190],
                [0xff, 0xc5, 0x00, 180],
                [0xff, 0xd0, 0x00, 180],
                [0xff, 0xd5, 0x00, 180],
                [0xff, 0xe0, 0x00, 170],
                [0xff, 0xe5, 0x00, 170],
                [0xff, 0xf0, 0x00, 170],
                [0xff, 0xff, 0x00, 160], // yellow
                [0xa0, 0xff, 0x40, 150],
                [0x60, 0xff, 0x20, 140],
                [0x00, 0xff, 0x00, 130], // lime
                [0x00, 0xaf, 0x80, 110],
                [0x00, 0x4f, 0xc0, 90],
                [0x00, 0x4f, 0xff, 60], // blue
                [0x00, 0x4f, 0xff, 30],
                [0x00, 0x4f, 0xff, 5]
            ];
        this._metric = HeatMapMetric.Manhattan;
        this._spreadUnits = HeatMapSpreadUnits.Viewport;
        this._chamferSize = 3;
        this._field = null;
        this._imgdata = null;
        this._updater = () => this.updateHeatMap();
        this._changer = (e) => {
            if (e.isTransactionFinished)
                this.updateHeatMap();
        };
        if (diag instanceof go.Diagram) {
            this.diagram = diag;
            if (init)
                Object.assign(this, init);
        }
        else if (typeof diag === 'object') {
            Object.assign(this, diag);
        }
    }
    // Gets or sets the Diagram that this HeatMap is working on.  The default is null.
    get diagram() {
        return this._diagram;
    }
    set diagram(value) {
        if (value !== this.diagram) {
            if (this.diagram !== null) {
                this.diagram.removeDiagramListener('ViewportBoundsChanged', this._updater);
                this.diagram.removeModelChangedListener(this._changer);
                this.diagram.remove(this.heatMapPart);
            }
            this._diagram = value;
            if (this.diagram !== null) {
                this.diagram.add(this.heatMapPart);
                this.diagram.addDiagramListener('ViewportBoundsChanged', this._updater);
                this.diagram.addModelChangedListener(this._changer);
                this.updateHeatMap();
            }
        }
    }
    // Gets the Part that must be in a Layer.isViewportAligned Layer that holds
    // the raster image showing the computed heat map.
    get heatMapPart() {
        return this._heatMapPart;
    }
    set heatMapPart(value) {
        if (value !== this.heatMapPart) {
            if (this.diagram !== null)
                this.diagram.remove(this.heatMapPart);
            this._heatMapPart = value;
            if (this.diagram !== null)
                this.diagram.add(this.heatMapPart);
        }
    }
    // Gets or sets the Array of Array of RGBA color numbers to use in forming gradients.
    get colors() {
        return this._colors;
    }
    set colors(value) {
        if (!Array.isArray(value) ||
            value.length < 2 ||
            !value.every((a) => Array.isArray(a) && a.length === 4 && a.every((n) => typeof n === 'number'))) {
            throw new Error('HeatMap.colors must be an Array of Array of four numbers, not: ' + value);
        }
        this._colors = value;
        this.updateHeatMap();
    }
    /**
     * Gets or sets the distance metric by which heat spreads outward from each Part.
     * {@link HeatMapMetric.Manhattan} produces diamond-shaped halos;
     * {@link HeatMapMetric.Euclidean} produces approximately circular ones.
     *
     * The default value is {@link HeatMapMetric.Manhattan}.
     */
    get metric() {
        return this._metric;
    }
    set metric(value) {
        if (this.metric !== value &&
            (value === HeatMapMetric.Manhattan || value === HeatMapMetric.Euclidean)) {
            this._metric = value;
            this.updateHeatMap();
        }
    }
    /**
     * Gets or sets the coordinate system in which heat spread distances are measured.
     * {@link HeatMapSpreadUnits.Viewport} spreads one canvas pixel per {@link colors} entry,
     * so halos keep the same size on screen regardless of zoom.
     * {@link HeatMapSpreadUnits.Document} spreads one document unit per {@link colors} entry,
     * so halos scale together with Parts as the user zooms.
     *
     * The default value is {@link HeatMapSpreadUnits.Viewport}.
     */
    get spreadUnits() {
        return this._spreadUnits;
    }
    set spreadUnits(value) {
        if (this.spreadUnits !== value &&
            (value === HeatMapSpreadUnits.Viewport || value === HeatMapSpreadUnits.Document)) {
            this._spreadUnits = value;
            this.updateHeatMap();
        }
    }
    /**
     * Gets or sets the size of the chamfer neighborhood used when the {@link metric} is
     * {@link HeatMapMetric.Euclidean}.
     * A value of 3 sweeps a 3x3 neighborhood, approximating Euclidean distance to within
     * about 8%, so large halos look subtly octagonal.
     * A value of 5 also sweeps the knight's-move neighbors of a 5x5 neighborhood,
     * approximating Euclidean distance to within about 2%, so halos look round,
     * at roughly double the rendering cost.
     * This has no effect when the metric is {@link HeatMapMetric.Manhattan},
     * which is computed exactly.
     *
     * The default value is 3.
     */
    get chamferSize() {
        return this._chamferSize;
    }
    set chamferSize(value) {
        if (this.chamferSize !== value && (value === 3 || value === 5)) {
            this._chamferSize = value;
            this.updateHeatMap();
        }
    }
    /**
     * Gets or sets whether the heat map image is drawn in front of all Parts,
     * in the "ViewportForeground" Layer, or behind them, in the "ViewportBackground" Layer.
     *
     * The default value is true.
     */
    get isInForeground() {
        return this.heatMapPart.layerName === 'ViewportForeground';
    }
    set isInForeground(value) {
        if (this.isInForeground !== value) {
            // remove and re-add the part around the layer change: assigning layerName alone
            // does not get the part into the new viewport-aligned layer's in-view parts list,
            // so it would not be drawn until the next viewport change
            const diag = this.diagram;
            if (diag !== null)
                diag.remove(this.heatMapPart);
            this.heatMapPart.layerName = value ? 'ViewportForeground' : 'ViewportBackground';
            if (diag !== null) {
                diag.add(this.heatMapPart);
                this.updateHeatMap();
            }
        }
    }
    /**
     * Override this method to customize getting the value for how "hot" the given Part is.
     * Typically this is overridden to return some numeric property of the Part.data.
     * By default it returns one, the maximum, assuming the normalizeTemperature method does not scale the value.
     * @param part
     * @returns a number indicating the Part's temperature, where smaller values are cooler.
     * @see {@link normalizeTemperature}
     */
    getTemperature(part) {
        return 1;
    }
    /**
     * Override this method to shift and scale the given temperature to get a fraction between zero and one, inclusive.
     * A value of zero indicates that the given Part not participate in the heat map.
     * Values between zero and one select the starting color from the colors Array -- higher values get more colors.
     * By default it just returns the given value, making sure the value is between zero and one.
     * @param temp
     * @returns a fraction between zero and one, inclusive
     * @see {@link getTemperature}
     * @see {@link computeStartingColorIndex}
     */
    normalizeTemperature(temp) {
        if (temp < 0)
            return 0;
        if (temp > 1)
            return 1;
        return temp;
    }
    /**
     * Override this method to customize the computation of the starting index in the {@link colors} Array
     * given the fraction computed by normalizeTemperature.
     * The default behavior is a simple linear interpolation.
     * The value must be a valid index into the colors Array.
     * @param frac a number between zero and one, inclusive
     * @returns an index into {@link colors}
     * @see {@link normalizeTemperature}
     */
    computeStartingColorIndex(frac) {
        const len1 = this.colors.length - 1;
        let i = Math.round(len1 * (1 - frac));
        if (i < 0)
            return 0;
        if (i > len1)
            return len1;
        return i;
    }
    /**
     * Return an ImageData of the given SIZE in pixels for the given AREA in document coordinates.
     * @param area a Rect in document coordinates
     * @param size a Size in device-independent-pixel/viewport coordinates
     * @returns ImageData or null
     */
    renderImageData(area, size) {
        const diag = this.diagram;
        if (!diag)
            return null;
        if (area.width < 1 || area.height < 1)
            return null;
        const w = Math.round(size.width);
        const h = Math.round(size.height);
        const scale = Math.min(w / area.width, h / area.height);
        const canvas = document.createElement('canvas');
        return this._renderHeatMap(canvas, area, w, h, scale);
    }
    /**
     * Update the heatMapPart's raster image for the viewport.
     */
    updateHeatMap() {
        const diag = this.diagram;
        if (!diag)
            return;
        if (diag.animationManager.isAnimating)
            return;
        if (!this.heatMapPart.isVisible())
            return;
        const vb = diag.viewportBounds;
        const w = Math.round(vb.width * diag.scale);
        const h = Math.round(vb.height * diag.scale);
        const picture = this.heatMapPart.findObject('IMG');
        picture.width = vb.width;
        picture.height = vb.height;
        picture.scale = diag.scale;
        const canvas = picture.element;
        canvas.width = w;
        canvas.height = h;
        this._renderHeatMap(canvas, vb, w, h, diag.scale, true);
        picture.redraw();
    }
    // internal method that actually does the heat map computation and rendering;
    // pass reuse only for the repeated viewport updates, never for renderImageData,
    // whose returned ImageData callers may keep
    _renderHeatMap(canvas, vvb, vw, vh, sc, reuse = false) {
        const diag = this.diagram;
        if (!diag)
            return null;
        if (!vvb.isReal())
            return null;
        const ctx = canvas.getContext('2d');
        const len1 = this.colors.length - 1;
        // how many gradient steps of heat each canvas pixel travelled consumes
        const step = this._spreadUnits === HeatMapSpreadUnits.Document ? 1 / sc : 1;
        // Parts beyond the visible area can still push heat into it so the field extends past the canvas by the maximum reach of the gradient
        // vb its document bounds while vw and vh are the visible output size
        const margin = Math.min(1024, Math.ceil(len1 / step));
        const w = vw + 2 * margin;
        const h = vh + 2 * margin;
        const mdoc = margin / sc;
        const vb = new go.Rect(vvb.x - mdoc, vvb.y - mdoc, vvb.width + 2 * mdoc, vvb.height + 2 * mdoc);
        const INF = 1e9;
        // reuse the cached buffers when their size still matches, to avoid
        // allocating several megabytes on every update
        let field = this._field;
        if (field === null || field.length !== w * h) {
            field = new Float32Array(w * h);
            this._field = field;
        }
        field.fill(INF);
        let imgdata;
        if (reuse &&
            this._imgdata !== null &&
            this._imgdata.width === vw &&
            this._imgdata.height === vh) {
            imgdata = this._imgdata;
            imgdata.data.fill(0);
        }
        else {
            imgdata = ctx.createImageData(vw, vh);
            if (reuse)
                this._imgdata = imgdata;
        }
        let seeded = false;
        // heat cannot spread beyond the seeded extent plus its maximum reach, so the
        // sweeps and colorize only need to process that window of the canvas
        const ext = { x0: w, y0: h, x1: -1, y1: -1, minC: len1 };
        const parts = diag.findPartsIn(vb, true, false);
        parts.each((part) => {
            if (part instanceof go.Link) {
                if (this._seedLink(part, vb, w, h, sc, field, ext))
                    seeded = true;
            }
            else {
                if (this._seedPart(part, vb, w, h, sc, field, ext))
                    seeded = true;
            }
        });
        // the window of the field that heat can actually occupy,
        // and its intersection with the visible output
        let rx0 = 0;
        let ry0 = 0;
        let rx1 = -1;
        let ry1 = -1;
        let ox0 = 0;
        let oy0 = 0;
        let ox1 = -1;
        let oy1 = -1;
        if (seeded) {
            // heat spreads at most this many pixels beyond the seeded extent
            const reach = Math.ceil((len1 - ext.minC) / step);
            rx0 = Math.max(0, ext.x0 - reach);
            ry0 = Math.max(0, ext.y0 - reach);
            rx1 = Math.min(w - 1, ext.x1 + reach);
            ry1 = Math.min(h - 1, ext.y1 + reach);
            if (this._metric === HeatMapMetric.Euclidean) {
                // 8-neighbor sweeps whose diagonal moves cost sqrt(2) approximate
                // Euclidean distance, producing approximately circular halos;
                // a chamferSize of 5 also sweeps the knight's-move neighbors at cost sqrt(5),
                // tightening the approximation so large halos look round instead of octagonal
                const diag = step * Math.SQRT2;
                const use5 = this._chamferSize === 5;
                const knight = step * Math.sqrt(5);
                // forward sweep: propagate from the left, top, and both upper diagonals
                for (let j = ry0; j <= ry1; j++) {
                    const row = j * w;
                    for (let i = rx0; i <= rx1; i++) {
                        const k = row + i;
                        let v = field[k];
                        if (i > 0 && field[k - 1] + step < v)
                            v = field[k - 1] + step;
                        if (j > 0) {
                            if (field[k - w] + step < v)
                                v = field[k - w] + step;
                            if (i > 0 && field[k - w - 1] + diag < v)
                                v = field[k - w - 1] + diag;
                            if (i < w - 1 && field[k - w + 1] + diag < v)
                                v = field[k - w + 1] + diag;
                        }
                        if (use5) {
                            if (j > 0) {
                                if (i > 1 && field[k - w - 2] + knight < v)
                                    v = field[k - w - 2] + knight;
                                if (i < w - 2 && field[k - w + 2] + knight < v)
                                    v = field[k - w + 2] + knight;
                            }
                            if (j > 1) {
                                if (i > 0 && field[k - 2 * w - 1] + knight < v)
                                    v = field[k - 2 * w - 1] + knight;
                                if (i < w - 1 && field[k - 2 * w + 1] + knight < v)
                                    v = field[k - 2 * w + 1] + knight;
                            }
                        }
                        field[k] = v;
                    }
                }
                // backward sweep: propagate from the right, bottom, and both lower diagonals
                for (let j = ry1; j >= ry0; j--) {
                    const row = j * w;
                    for (let i = rx1; i >= rx0; i--) {
                        const k = row + i;
                        let v = field[k];
                        if (i < w - 1 && field[k + 1] + step < v)
                            v = field[k + 1] + step;
                        if (j < h - 1) {
                            if (field[k + w] + step < v)
                                v = field[k + w] + step;
                            if (i < w - 1 && field[k + w + 1] + diag < v)
                                v = field[k + w + 1] + diag;
                            if (i > 0 && field[k + w - 1] + diag < v)
                                v = field[k + w - 1] + diag;
                        }
                        if (use5) {
                            if (j < h - 1) {
                                if (i < w - 2 && field[k + w + 2] + knight < v)
                                    v = field[k + w + 2] + knight;
                                if (i > 1 && field[k + w - 2] + knight < v)
                                    v = field[k + w - 2] + knight;
                            }
                            if (j < h - 2) {
                                if (i < w - 1 && field[k + 2 * w + 1] + knight < v)
                                    v = field[k + 2 * w + 1] + knight;
                                if (i > 0 && field[k + 2 * w - 1] + knight < v)
                                    v = field[k + 2 * w - 1] + knight;
                            }
                        }
                        field[k] = v;
                    }
                }
            }
            else {
                // 4-neighbor sweeps compute exact city-block distance, producing diamond halos
                // forward sweep: propagate from the left and top
                for (let j = ry0; j <= ry1; j++) {
                    const row = j * w;
                    for (let i = rx0; i <= rx1; i++) {
                        const k = row + i;
                        let v = field[k];
                        if (i > 0 && field[k - 1] + step < v)
                            v = field[k - 1] + step;
                        if (j > 0 && field[k - w] + step < v)
                            v = field[k - w] + step;
                        field[k] = v;
                    }
                }
                // backward sweep: propagate from the right and bottom
                for (let j = ry1; j >= ry0; j--) {
                    const row = j * w;
                    for (let i = rx1; i >= rx0; i--) {
                        const k = row + i;
                        let v = field[k];
                        if (i < w - 1 && field[k + 1] + step < v)
                            v = field[k + 1] + step;
                        if (j < h - 1 && field[k + w] + step < v)
                            v = field[k + w] + step;
                        field[k] = v;
                    }
                }
            }
            // map the visible portion of the field into the gradient and shift field coordinates back by the margin to output coordinates
            const d = imgdata.data;
            const colors = this.colors;
            const jlo = Math.max(ry0, margin);
            const jhi = Math.min(ry1, margin + vh - 1);
            const ilo = Math.max(rx0, margin);
            const ihi = Math.min(rx1, margin + vw - 1);
            for (let j = jlo; j <= jhi; j++) {
                const row = j * w;
                const orow = (j - margin) * vw;
                for (let i = ilo; i <= ihi; i++) {
                    const v = field[row + i];
                    if (v <= len1) {
                        // v <= len1 guarantees the rounded index stays within the colors Array
                        const c = colors[Math.round(v)];
                        const k4 = 4 * (orow + (i - margin));
                        d[k4] = c[0];
                        d[k4 + 1] = c[1];
                        d[k4 + 2] = c[2];
                        d[k4 + 3] = c[3];
                    }
                }
            }
            if (jhi >= jlo && ihi >= ilo) {
                ox0 = ilo - margin;
                oy0 = jlo - margin;
                ox1 = ihi - margin;
                oy1 = jhi - margin;
            }
        }
        ctx.clearRect(0, 0, vw, vh);
        // only upload the window that heat occupies
        if (ox1 >= ox0 && oy1 >= oy0) {
            ctx.putImageData(imgdata, 0, 0, ox0, oy0, ox1 - ox0 + 1, oy1 - oy0 + 1);
        }
        return imgdata;
    }
    // widen the pending seeded extent by this part's canvas-pixel bounds and starting index
    _extendExtent(ext, b, vb, sc, startC) {
        const x0 = Math.round((b.x - vb.x) * sc);
        const y0 = Math.round((b.y - vb.y) * sc);
        const x1 = Math.round((b.right - vb.x) * sc);
        const y1 = Math.round((b.bottom - vb.y) * sc);
        if (x0 < ext.x0)
            ext.x0 = x0;
        if (y0 < ext.y0)
            ext.y0 = y0;
        if (x1 > ext.x1)
            ext.x1 = x1;
        if (y1 > ext.y1)
            ext.y1 = y1;
        if (startC < ext.minC)
            ext.minC = startC;
    }
    _seedLink(part, vb, w, h, sc, field, ext) {
        const frac = this.normalizeTemperature(this.getTemperature(part));
        if (frac <= 0)
            return false;
        const startC = this.computeStartingColorIndex(frac);
        if (part.pointsCount < 2)
            return false;
        const b = part.routeBounds.copy();
        if (!b.intersectsRect(vb))
            return false;
        this._extendExtent(ext, b, vb, sc, startC);
        if (part.computeCurve() === go.Curve.Bezier) {
            for (let i = 0; i < part.pointsCount - 1; i += 3) {
                let p = part.getPoint(i);
                const p0x = Math.round((p.x - vb.x) * sc);
                const p0y = Math.round((p.y - vb.y) * sc);
                p = part.getPoint(i + 1);
                const p1x = Math.round((p.x - vb.x) * sc);
                const p1y = Math.round((p.y - vb.y) * sc);
                p = part.getPoint(i + 2);
                const p2x = Math.round((p.x - vb.x) * sc);
                const p2y = Math.round((p.y - vb.y) * sc);
                p = part.getPoint(i + 3);
                const p3x = Math.round((p.x - vb.x) * sc);
                const p3y = Math.round((p.y - vb.y) * sc);
                const pix = Math.abs(p0x - p1x) +
                    Math.abs(p1x - p2x) +
                    Math.abs(p2x - p3x) +
                    Math.abs(p0y - p1y) +
                    Math.abs(p1y - p2y) +
                    Math.abs(p2y - p3y);
                if (pix < 2)
                    continue;
                for (let t = 0; t <= 1; t += 1 / pix) {
                    const t1 = 1 - t;
                    let c0 = t1 * t1;
                    let c3 = t * t;
                    const c1 = 3 * c0 * t;
                    const c2 = 3 * t1 * c3;
                    c0 *= t1;
                    c3 *= t;
                    const px = Math.round(c0 * p0x + c1 * p1x + c2 * p2x + c3 * p3x);
                    if (px < 0 || px >= w)
                        continue;
                    const py = Math.round(c0 * p0y + c1 * p1y + c2 * p2y + c3 * p3y);
                    if (py < 0 || py >= h)
                        continue;
                    const k = py * w + px;
                    if (startC < field[k])
                        field[k] = startC;
                }
            }
        }
        else {
            // assumes straight line segments -- ignore all labels and Link.corner and jump-overs
            let vp = part.getPoint(0).copy();
            vp.x = Math.round((vp.x - vb.x) * sc);
            vp.y = Math.round((vp.y - vb.y) * sc);
            for (let i = 1; i < part.pointsCount; i++) {
                const vq = part.getPoint(i).copy();
                vq.x = Math.round((vq.x - vb.x) * sc);
                vq.y = Math.round((vq.y - vb.y) * sc);
                if (vp.x === vq.x && vp.y === vq.y)
                    continue;
                // draw points along straight line of route (no curves here) from VP to VQ
                const m = Math.abs(vq.x - vp.x) > Math.abs(vq.y - vp.y) ? vq.x - vp.x : vq.y - vp.y;
                const am = Math.abs(m);
                const dx = (vq.x - vp.x) / am;
                const dy = (vq.y - vp.y) / am;
                for (let z = 0; z < am; z++) {
                    const x2 = Math.round(vp.x + z * dx);
                    if (x2 < 0 || x2 >= w)
                        continue;
                    const y2 = Math.round(vp.y + z * dy);
                    if (y2 < 0 || y2 >= h)
                        continue;
                    const k2 = y2 * w + x2;
                    if (startC < field[k2])
                        field[k2] = startC;
                }
                vp = vq;
            }
        }
        return true;
    }
    _seedPart(part, vb, w, h, sc, field, ext) {
        const frac = this.normalizeTemperature(this.getTemperature(part));
        if (frac <= 0)
            return false;
        const startC = this.computeStartingColorIndex(frac);
        let obj = part.selectionObject;
        if (obj instanceof go.Panel &&
            (obj.type === go.Panel.Auto || obj.type === go.Panel.Spot)) {
            obj = obj.findMainElement();
        }
        if (!obj)
            return false;
        const b = obj.getDocumentBounds().copy();
        if (!b.intersectsRect(vb))
            return false;
        this._extendExtent(ext, b, vb, sc, startC);
        if (obj instanceof go.Shape &&
            (obj.figure === 'Ellipse' || obj.figure === 'Circle') &&
            obj.getDocumentAngle() === 0) {
            // convert to canvas coordinates
            const tlx = Math.round((b.x - vb.x) * sc);
            const tly = Math.round((b.y - vb.y) * sc);
            const brx = Math.round((b.right - vb.x) * sc);
            const bry = Math.round((b.bottom - vb.y) * sc);
            const rx = Math.round((brx - tlx) / 2);
            const ry = Math.round((bry - tly) / 2);
            const ox = tlx + rx;
            const oy = tly + ry;
            const ww = rx * rx;
            const hh = ry * ry;
            const wwhh = ww * hh;
            let x0 = rx;
            let dx = 0;
            for (let x = -rx; x <= rx; x++) {
                if (oy >= 0 && oy < h && ox + x >= 0 && ox + x < w) {
                    const k = oy * w + (ox + x);
                    if (startC < field[k])
                        field[k] = startC;
                }
            }
            for (let y = 1; y <= ry; y++) {
                let x1 = x0 - (dx - 1);
                for (; x1 > 0; x1--) {
                    if (x1 * x1 * hh + y * y * ww < wwhh)
                        break;
                }
                dx = x0 - x1;
                x0 = x1;
                for (let x = -x0; x <= x0; x++) {
                    if (oy - y >= 0 && oy - y < h && ox + x >= 0 && ox + x < w) {
                        const km = (oy - y) * w + (ox + x);
                        if (startC < field[km])
                            field[km] = startC;
                    }
                    if (oy + y >= 0 && oy + y < h && ox + x >= 0 && ox + x < w) {
                        const kp = (oy + y) * w + (ox + x);
                        if (startC < field[kp])
                            field[kp] = startC;
                    }
                }
            }
        }
        else {
            // assumes rectangular selectionObject
            let tl = new go.Point(b.x, b.y);
            tl.x = Math.round((tl.x - vb.x) * sc);
            tl.y = Math.round((tl.y - vb.y) * sc);
            let br = new go.Point(b.right, b.bottom);
            br.x = Math.round((br.x - vb.x) * sc);
            br.y = Math.round((br.y - vb.y) * sc);
            for (let j = tl.y; j <= br.y; j++) {
                if (j < 0 || j >= h)
                    continue;
                for (let i = tl.x; i <= br.x; i++) {
                    if (i < 0 || i >= w)
                        continue;
                    const k = j * w + i;
                    if (startC < field[k])
                        field[k] = startC;
                }
            }
        }
        return true;
    }
}
