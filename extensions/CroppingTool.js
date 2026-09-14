/*
 *  Copyright 1998-2026 by Northwoods Software Corporation. All Rights Reserved.
 */
/*
 * This is an extension and not part of the main GoJS library.
 * The source code for this is at extensionsJSM/CroppingTool.ts.
 * Note that the API for this class may change with any version, even point releases.
 * If you intend to use an extension in production, you should copy the code to your own source directory.
 * Extensions can be found in the GoJS kit under the extensions or extensionsJSM folders.
 * See the Extensions learn page (https://gojs.net/learn/extensions) for more information.
 */

/**
 * A custom tool for cropping a {@link go.Picture} in a selected Part
 * by modifying its {@link go.Picture.sourceRect}.
 *
 * Install the CroppingTool as a mouse-down tool by calling:
 * `myDiagram.toolManager.mouseDownTools.insertAt(4, new CroppingTool());`
 *
 * Call {@link startCropping} with a Part (or with no argument to use the
 * diagram's primary selection) to begin cropping.  The tool then shows the
 * whole image in a temporary unmodeled Part, with the current crop rectangle
 * highlighted and surrounded by "Cropping" handles.  Dragging those handles
 * changes the crop rectangle, and dragging within the crop rectangle moves it
 * around over the image. Both transformations are always limited to the bounds of the image.
 * Call {@link stopCropping} (or deselect the temporary Part) to finish.
 * The new crop is then applied to the Part's Picture by setting
 * {@link go.Picture.sourceRect} in a transaction.
 *
 * The Picture to be cropped is found in the Part by name, {@link croppedObjectName},
 * which defaults to "IMG".
 *
 * If you want to experiment with this extension, try the <a href="/samples/Cropping">Cropping</a> sample.
 * @category Tool Extension
 */
class CroppingTool extends go.ResizingTool {
    constructor(init) {
        super();
        this.name = 'Cropping';
        this._croppedObjectName = 'IMG';
        this._minViewSize = 52;
        this._aspectRatio = null;
        this._nodeBeingCropped = null;
        this._originalSourceRect = new go.Rect();
        this._startPoint = new go.Point();
        // while cropping keep the handles at a constant size on screen as the user zooms
        this._viewportListener = () => this.updateAdornments(this._croppingPart);
        this._baseFocus = new WeakMap();
        // a temporary Part shown while cropping, displaying the whole image dimmed with the cropped portion of the image shown at its position in the full image
        this._croppingPart = new go.Part({
            selectionObjectName: 'CROPPED',
            selectionAdorned: false,
            selectionChanged: (part) => {
                if (!part.isSelected)
                    this.stopCropping();
            },
            copyable: false,
            deletable: false,
            movable: false,
            background: 'gray',
            layerName: 'Adornment',
            position: new go.Point(0, 0) // make sure this is initially real
        }).add(new go.Panel('Spot').add(new go.Picture({
            name: 'FULL',
            imageStretch: go.ImageStretch.None,
            imageAlignment: go.Spot.TopLeft
        }), new go.Shape({ fill: '#888888A0', strokeWidth: 0, stretch: go.Stretch.Fill })), new go.Picture({
            name: 'CROPPED',
            imageStretch: go.ImageStretch.None,
            imageAlignment: go.Spot.TopLeft
        }));
        if (init)
            Object.assign(this, init);
    }
    /**
     * Gets or sets the name of the {@link go.Picture} in the cropped Part
     * that this tool operates on, found via {@link go.Panel.findObject}.
     *
     * The default value is "IMG".
     */
    get croppedObjectName() {
        return this._croppedObjectName;
    }
    set croppedObjectName(val) {
        this._croppedObjectName = val;
    }
    /**
     * Gets or sets the minimum width and height of the crop rectangle,
     * measured in viewport pixels rather than image pixels.
     *
     * Because the cropping handles keep a constant size on screen, this keeps
     * them from overlapping each other. Zooming in lets the user make finer crops.
     * {@link computeMinSize} converts this to image pixels at the current {@link go.Diagram.scale}.
     *
     * The default value is 52.
     */
    get minViewSize() {
        return this._minViewSize;
    }
    set minViewSize(val) {
        this._minViewSize = val;
    }
    /**
     * Gets or sets the aspect ratio that the crop rectangle is locked to or
     * null to allow crops of any proportions.
     *
     * When locked, dragging a corner handle keeps the opposite corner fixed,
     * dragging a side handle keeps the opposite side fixed and grows the crop
     * about its center in the other direction.
     *
     * Even when this property is null, the user can hold down the Shift key
     * while dragging a handle to maintain the proportions, just as with the
     * standard {@link go.ResizingTool}.
     *
     * The default value is null.
     */
    get aspectRatio() {
        return this._aspectRatio;
    }
    set aspectRatio(val) {
        this._aspectRatio = val;
    }
    /**
     * This read-only property returns the Part whose Picture is currently being cropped,
     * or null when no cropping is in progress.
     */
    get nodeBeingCropped() {
        return this._nodeBeingCropped;
    }
    /**
     * This read-only property is true when a cropping operation is in progress.
     * After {@link startCropping} and before the corresponding
     * {@link stopCropping}.
     */
    get isCropping() {
        return this._nodeBeingCropped !== null;
    }
    /**
     * This read-only property returns the temporary unmodeled Part that is shown
     * in the "Adornment" Layer while cropping is in progress.
     * It holds a Picture named "FULL" showing the whole image, a dimming Shape,
     * and a Picture named "CROPPED" showing the currently cropped portion.
     */
    get croppingPart() {
        return this._croppingPart;
    }
    /**
     * Start a cropping operation on the given Part, or on the diagram's primary
     * selection if no Part is given.
     *
     * This finds the {@link go.Picture} named {@link croppedObjectName} within the Part,
     * shows the {@link croppingPart} rotated and centered on the Part's Picture,
     * and selects it so that "Cropping" handles appear around the cropped portion
     * of the image.  The {@link croppingPart} is scaled so that the full image
     * appears at the size that the Picture occupies in the Part.
     *
     * This method has no effect if a cropping operation is already in progress
     * or if no suitable Picture can be found.
     */
    startCropping(part) {
        const diagram = this.diagram;
        if (diagram === null || diagram.isReadOnly)
            return;
        if (this._nodeBeingCropped !== null)
            return; // already cropping
        let node = part;
        if (node === undefined) {
            const sel = diagram.selection.first();
            if (sel === null)
                return;
            node = sel;
        }
        if (node instanceof go.Link)
            return;
        const pic = node.findObject(this.croppedObjectName);
        if (!(pic instanceof go.Picture))
            return;
        const croppingPart = this._croppingPart;
        const full = croppingPart.findObject('FULL');
        const cropped = croppingPart.findObject('CROPPED');
        if (!(full instanceof go.Picture) || !(cropped instanceof go.Picture))
            return;
        this._nodeBeingCropped = node;
        // set up and show the croppingPart
        diagram.commit((diag) => {
            const cb = pic.sourceRect.copy();
            if (!cb.isReal())
                cb.set(pic.naturalBounds); // no sourceRect means the whole image
            let cs = pic.getDocumentScale();
            // scale the croppingPart so that the FULL image appears at the size that the Picture occupies in the node
            const el = pic.element;
            let natw = 0;
            let nath = 0;
            if (el instanceof HTMLImageElement) {
                natw = el.naturalWidth;
                nath = el.naturalHeight;
            }
            else if (el !== null) {
                natw = el.width;
                nath = el.height;
            }
            if (natw > 0 && nath > 0) {
                // the area available for displaying the image
                const pb = pic.naturalBounds;
                let boxw = pb.width * cs;
                let boxh = pb.height * cs;
                // when the Picture is inside a Viewbox Panel
                const container = pic.panel;
                if (container !== null && container.type === go.Panel.Viewbox && container.naturalBounds.isReal()) {
                    const s = container.getDocumentScale();
                    boxw = container.naturalBounds.width * s;
                    boxh = container.naturalBounds.height * s;
                }
                cs = Math.min(boxw / natw, boxh / nath);
                // but never so large that the full image doesn't fit within the viewport
                const vb = diagram.viewportBounds;
                if (vb.isReal()) {
                    const fit = 0.9 * Math.min(vb.width / natw, vb.height / nath);
                    if (isFinite(fit) && fit > 0)
                        cs = Math.min(cs, fit);
                }
            }
            full.source = pic.source; // FULL shows whole image
            cropped.source = pic.source; // CROPPED shows cropped image
            cropped.sourceRect = cb;
            cropped.position = cb.position; // position and size cropped image appropriately in full image
            cropped.desiredSize = cb.size;
            croppingPart.scale = cs; // scale and rotate croppingPart so it's like PIC
            croppingPart.angle = pic.getDocumentAngle();
            croppingPart.ensureBounds(); // determine correct sizes before positioning it
            // center the FULL image on the Picture, so that the croppingPart always
            // appears at the same place no matter where in the image the crop is
            croppingPart.position = pic
                .getDocumentPoint(go.Spot.Center)
                .subtract(full.getDocumentPoint(go.Spot.Center).subtract(croppingPart.position));
            diag.add(croppingPart);
            diag.select(croppingPart);
        }, null); // skipsUndoManager
        diagram.scrollToRect(croppingPart.actualBounds); // in case the full image extends off-screen
        diagram.addDiagramListener('ViewportBoundsChanged', this._viewportListener);
    }
    /**
     * Finish the current cropping operation, if any.
     *
     * This removes the {@link croppingPart} from the diagram and, unless APPLY is false,
     * assigns the new crop rectangle to the {@link go.Picture.sourceRect} of the cropped
     * Part's Picture.
     *
     * This is called automatically when the {@link croppingPart} is deselected.
     * @param apply - whether to apply the new crop rectangle to the Part's Picture, default true.
     */
    stopCropping(apply) {
        if (apply === undefined)
            apply = true;
        const node = this._nodeBeingCropped;
        if (node === null)
            return;
        this._nodeBeingCropped = null;
        if (this.diagram !== null) {
            this.diagram.removeDiagramListener('ViewportBoundsChanged', this._viewportListener);
        }
        const diagram = node.diagram;
        const croppingPart = this._croppingPart;
        const full = croppingPart.findObject('FULL');
        const cropped = croppingPart.findObject('CROPPED');
        if (diagram === null || !(full instanceof go.Picture) || !(cropped instanceof go.Picture))
            return;
        const newview = cropped.sourceRect.copy();
        // take down the croppingPart
        diagram.commit((diag) => {
            full.source = ''; // release references to image
            cropped.source = '';
            diag.remove(croppingPart);
        }, null); // skipsUndoManager
        if (apply) {
            const pic = node.findObject(this.croppedObjectName);
            if (pic instanceof go.Picture) {
                // actually modify the node's Picture, in a normal transaction
                diagram.commit(() => {
                    pic.sourceRect = newview;
                }, this.name);
            }
        }
    }
    /**
     * This tool may run when there is a mouse-down on a "Cropping" handle of the
     * selected {@link croppingPart}, including the invisible handle named "MOVER"
     * that covers the whole crop rectangle and moves it around over the image.
     */
    canStart() {
        const diagram = this.diagram;
        if (diagram === null || diagram.isReadOnly)
            return false;
        const h = this.findToolHandleAt(diagram.firstInput.documentPoint, this.name);
        if (h === null)
            return false;
        const ad = h.part;
        return ad instanceof go.Adornment && ad.adornedPart === this._croppingPart;
    }
    /**
     * Create an {@link go.Adornment} holding eight cropping handles around the
     * cropped portion of the image  and an invisible handle covering the crop
     * rectangle so that it can be dragged around.
     * @param cropObj - the "CROPPED" Picture of the {@link croppingPart}
     */
    makeAdornment(cropObj) {
        const adornment = new go.Adornment(go.Panel.Spot);
        // position the adornment by its main outline box, so that it always exactly
        // covers the crop rectangle no matter how far the handles stick out
        adornment.locationSpot = go.Spot.TopLeft;
        adornment.locationObjectName = 'BOX';
        adornment.add(new go.Shape({ name: 'BOX', fill: 'transparent', stroke: 'transparent' }));
        // an invisible handle covering the whole crop rectangle for moving it
        adornment.add(new go.Shape({
            name: 'MOVER',
            alignment: go.Spot.Center,
            fill: 'transparent',
            strokeWidth: 0,
            cursor: 'move'
        }));
        const LONG = 18;
        const THICK = 6;
        const FILL = '#333';
        const STROKE = '#CCC';
        adornment.add(new go.Shape({
            alignment: go.Spot.TopLeft,
            alignmentFocus: new go.Spot(0, 0, 3, 3),
            geometryString: 'F1 M0 0 h18 v6 h-12 v12 h-6z',
            fill: FILL,
            stroke: STROKE,
            cursor: 'nw-resize'
        }), new go.Shape({
            alignment: go.Spot.TopRight,
            alignmentFocus: new go.Spot(1, 0, -3, 3),
            geometryString: 'F1 M0 0 h18 v18 h-6 v-12 h-12z',
            fill: FILL,
            stroke: STROKE,
            cursor: 'ne-resize'
        }), new go.Shape({
            alignment: go.Spot.BottomRight,
            alignmentFocus: new go.Spot(1, 1, -3, -3),
            geometryString: 'F1 M12 0 h6 v18 h-18 v-6 h12z',
            fill: FILL,
            stroke: STROKE,
            cursor: 'se-resize'
        }), new go.Shape({
            alignment: go.Spot.BottomLeft,
            alignmentFocus: new go.Spot(0, 1, 3, -3),
            geometryString: 'F1 M0 0 h6 v12 h12 v6 h-18z',
            fill: FILL,
            stroke: STROKE,
            cursor: 'sw-resize'
        }), new go.Shape({
            alignment: go.Spot.Top,
            alignmentFocus: new go.Spot(0.5, 0, 0, 3),
            width: LONG,
            height: THICK,
            fill: FILL,
            stroke: STROKE,
            cursor: 'n-resize'
        }), new go.Shape({
            alignment: go.Spot.Bottom,
            alignmentFocus: new go.Spot(0.5, 1, 0, -3),
            width: LONG,
            height: THICK,
            fill: FILL,
            stroke: STROKE,
            cursor: 's-resize'
        }), new go.Shape({
            alignment: go.Spot.Left,
            alignmentFocus: new go.Spot(0, 0.5, 3, 0),
            width: THICK,
            height: LONG,
            fill: FILL,
            stroke: STROKE,
            cursor: 'w-resize'
        }), new go.Shape({
            alignment: go.Spot.Right,
            alignmentFocus: new go.Spot(1, 0.5, -3, 0),
            width: THICK,
            height: LONG,
            fill: FILL,
            stroke: STROKE,
            cursor: 'e-resize'
        }));
        adornment.adornedObject = cropObj;
        return adornment;
    }
    /**
     * Show an {@link go.Adornment} with cropping handles only for the selected
     * {@link croppingPart}, positioned around its "CROPPED" Picture.
     *
     * The "MOVER" handle is scaled to exactly cover the crop rectangle in the image.
     * The eight edge handles are inversely scaled by the {@link go.Diagram.scale} so
     * that they always appear at the same size on screen no matter how far the user has
     * zoomed in or out.
     * @param part
     */
    updateAdornments(part) {
        if (part === null)
            return;
        if (part === this._croppingPart && part.isSelected && !this.diagram.isReadOnly) {
            const cropObj = part.selectionObject;
            if (cropObj instanceof go.Picture &&
                part.actualBounds.isReal() &&
                part.isVisible() &&
                cropObj.actualBounds.isReal() &&
                cropObj.isVisibleObject()) {
                let adornment = part.findAdornment(this.name);
                if (adornment === null || adornment.adornedObject !== cropObj) {
                    adornment = this.makeAdornment(cropObj);
                }
                // handles are inversely scaled by the diagram scale to keep a constant screen size
                const hs = 1 / Math.max(this.diagram.scale, 0.000001);
                const box = adornment.elt(0);
                box.desiredSize = cropObj.actualBounds.size;
                box.scale = cropObj.getDocumentScale();
                if (box instanceof go.Shape)
                    box.strokeWidth = hs / box.scale; // one pixel on screen
                const mover = adornment.findObject('MOVER');
                if (mover !== null) {
                    mover.desiredSize = cropObj.actualBounds.size;
                    mover.scale = cropObj.getDocumentScale();
                }
                adornment.elements.each((h) => {
                    if (h === box || h === mover)
                        return;
                    h.scale = hs;
                    // alignmentFocus pixel offsets are in panel coordinates, so they must
                    // shrink along with the handles to keep them attached to the box edges
                    let base = this._baseFocus.get(h);
                    if (base === undefined) {
                        base = h.alignmentFocus;
                        this._baseFocus.set(h, base);
                    }
                    h.alignmentFocus = new go.Spot(base.x, base.y, base.offsetX * hs, base.offsetY * hs);
                });
                adornment.angle = cropObj.getDocumentAngle();
                adornment.location = cropObj.getDocumentPoint(go.Spot.TopLeft);
                part.addAdornment(this.name, adornment);
                return;
            }
        }
        part.removeAdornment(this.name);
    }
    /**
     * In addition to the standard {@link go.ResizingTool.doActivate} behavior,
     * hide the cropping handles and remember both the original
     * {@link go.Picture.sourceRect} and the starting mouse point in the
     * coordinate system of the full image.
     */
    doActivate() {
        super.doActivate();
        if (this.adornedObject === null)
            return;
        // hide handles during cropping
        const part = this.adornedObject.part;
        const ad = part !== null ? part.findAdornment(this.name) : null;
        if (ad !== null) {
            const main = ad.findMainElement();
            ad.elements.each((e) => {
                if (e !== main)
                    e.opacity = 0;
            });
        }
        this._startPoint = this._croppingPart.getLocalPoint(this.diagram.firstInput.documentPoint);
        const cropObj = this._croppingPart.selectionObject;
        if (!(cropObj instanceof go.Picture))
            return;
        this._originalSourceRect = cropObj.sourceRect.copy();
        if (!this._originalSourceRect.isReal())
            this._originalSourceRect.set(cropObj.naturalBounds);
    }
    /**
     * Show all of the cropping handles again.
     */
    doDeactivate() {
        if (this.adornedObject !== null) {
            const part = this.adornedObject.part;
            const ad = part !== null ? part.findAdornment(this.name) : null;
            if (ad !== null) {
                const main = ad.findMainElement();
                ad.elements.each((e) => {
                    if (e !== main)
                        e.opacity = 1;
                });
            }
        }
        super.doDeactivate();
    }
    /**
     * Restore the original crop rectangle.
     */
    doCancel() {
        if (this.adornedObject !== null)
            this.resize(this._originalSourceRect);
        this.stopTool();
    }
    /**
     * Change the crop rectangle of the "CROPPED" Picture.
     *
     * Assume NEWR is in the coordinate system of the full image due to the
     * {@link computeResize} override, not in the adorned object's local coordinates.
     * @param newr - the new crop rectangle, in the {@link croppingPart}'s coordinates
     */
    resize(newr) {
        const obj = this.adornedObject;
        if (obj instanceof go.Picture) {
            obj.sourceRect = newr;
            obj.position = newr.position;
            obj.desiredSize = newr.size;
        }
    }
    /**
     * In addition to the standard minimums, enforce {@link minViewSize} converted
     * from viewport pixels into image pixels at the current {@link go.Diagram.scale},
     * so that the constant-screen-size cropping handles never overlap each other.
     */
    computeMinSize() {
        const msz = super.computeMinSize();
        const obj = this.adornedObject;
        if (obj !== null) {
            // how many screen pixels one image pixel occupies right now
            const s = obj.getDocumentScale() * this.diagram.scale;
            if (s > 0) {
                msz.width = Math.max(msz.width, this.minViewSize / s);
                msz.height = Math.max(msz.height, this.minViewSize / s);
            }
        }
        return msz;
    }
    /**
     * Compute the new crop rectangle given the current mouse point.
     *
     * When the handle being dragged is the "MOVER" handle, this shifts the whole
     * crop rectangle by the distance the mouse has moved. When the handle is an edge
     * handle it moves the spot corresponding to the handle's alignment spot. When
     * {@link aspectRatio} is non-null, or when RESHAPE is false because the user is
     * holding down the Shift key, the crop rectangle keeps its proportions. In all cases
     * the result is limited to the bounds of the full image, and edges may not cross each other.
     *
     * Unlike the standard {@link go.ResizingTool.computeResize}, this returns the Rect in the
     * panel's coordinates, which correspond to the coordinate system of the full image.
     */
    computeResize(newPoint, spot, min, max, cell, reshape) {
        const b = this._originalSourceRect.copy();
        const obj = this.adornedObject;
        if (obj === null || obj.panel === null)
            return b;
        // the current mouse point in the coordinate system of the full image
        const pt = obj.panel.getLocalPoint(obj.getDocumentPoint(newPoint));
        // the bounds of the full image
        let maxw = Infinity;
        let maxh = Infinity;
        const full = this._croppingPart.findObject('FULL');
        if (full instanceof go.Picture && full.naturalBounds.isReal()) {
            maxw = full.naturalBounds.width;
            maxh = full.naturalBounds.height;
        }
        if (this.handle !== null && this.handle.name === 'MOVER') {
            // move the whole crop rectangle, keeping it within the image
            b.x = Math.round(Math.max(0, Math.min(maxw - b.width, b.x + pt.x - this._startPoint.x)));
            b.y = Math.round(Math.max(0, Math.min(maxh - b.height, b.y + pt.y - this._startPoint.y)));
            return b;
        }
        // don't let edges cross each other, keeping at least a minimum crop size
        const minw = Math.min(Math.max(1, min.width), b.width);
        const minh = Math.min(Math.max(1, min.height), b.height);
        // the ratio the crop is locked to, if any
        let ratio = NaN;
        if (this.aspectRatio !== null && this.aspectRatio > 0 && isFinite(this.aspectRatio)) {
            ratio = this.aspectRatio;
        }
        else if (!reshape && b.height > 0) {
            ratio = b.width / b.height;
        }
        if (isNaN(ratio)) {
            // freeform crop
            if (spot.x <= 0) {
                // move the left edge, keeping the right edge fixed
                const nx = Math.round(Math.min(Math.max(0, pt.x), b.right - minw));
                b.width = b.right - nx;
                b.x = nx;
            }
            else if (spot.x >= 1) {
                // move the right edge, keeping the left edge fixed
                const nr = Math.round(Math.max(Math.min(maxw, pt.x), b.x + minw));
                b.width = nr - b.x;
            }
            if (spot.y <= 0) {
                // move the top edge, keeping the bottom edge fixed
                const ny = Math.round(Math.min(Math.max(0, pt.y), b.bottom - minh));
                b.height = b.bottom - ny;
                b.y = ny;
            }
            else if (spot.y >= 1) {
                // move the bottom edge, keeping the top edge fixed
                const nb = Math.round(Math.max(Math.min(maxh, pt.y), b.y + minh));
                b.height = nb - b.y;
            }
            return b;
        }
        // ratio-locked crop
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        if (spot.x <= 0 || spot.x >= 1) {
            // a corner handle, or a left or right side handle: compute the new width first
            const fx = spot.x <= 0 ? b.right : b.x; // the fixed vertical edge
            const availw = spot.x <= 0 ? fx : maxw - fx;
            let fy = 0; // the fixed horizontal edge, for corner handles
            let availh = maxh;
            if (spot.y <= 0) {
                fy = b.bottom;
                availh = fy;
            }
            else if (spot.y >= 1) {
                fy = b.y;
                availh = maxh - fy;
            }
            const wmin = Math.max(minw, minh * ratio);
            const wmax = Math.min(availw, availh * ratio);
            // follow whichever direction the mouse has been dragged farther
            let w = spot.x <= 0 ? fx - pt.x : pt.x - fx;
            if (spot.y <= 0)
                w = Math.max(w, (fy - pt.y) * ratio);
            else if (spot.y >= 1)
                w = Math.max(w, (pt.y - fy) * ratio);
            w = Math.round(clamp(w, Math.min(wmin, wmax), wmax));
            const h = Math.round(w / ratio);
            b.width = w;
            b.height = h;
            b.x = spot.x <= 0 ? fx - w : fx;
            if (spot.y <= 0) {
                b.y = fy - h;
            }
            else if (spot.y >= 1) {
                b.y = fy;
            }
            else {
                // a side handle: grow about the vertical center of the original crop
                const cy = this._originalSourceRect.y + this._originalSourceRect.height / 2;
                b.y = Math.round(clamp(cy - h / 2, 0, maxh - h));
            }
        }
        else {
            // a top or bottom side handle: compute the new height first,
            // growing about the horizontal center of the original crop
            const fy = spot.y <= 0 ? b.bottom : b.y; // the fixed horizontal edge
            const availh = spot.y <= 0 ? fy : maxh - fy;
            const hmin = Math.max(minh, minw / ratio);
            const hmax = Math.min(availh, maxw / ratio);
            let h = spot.y <= 0 ? fy - pt.y : pt.y - fy;
            h = Math.round(clamp(h, Math.min(hmin, hmax), hmax));
            const w = Math.round(h * ratio);
            const cx = b.x + b.width / 2;
            b.width = w;
            b.height = h;
            b.y = spot.y <= 0 ? fy - h : fy;
            b.x = Math.round(clamp(cx - w / 2, 0, maxw - w));
        }
        return b;
    }
}
