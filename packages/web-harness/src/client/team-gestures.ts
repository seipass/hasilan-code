export interface GraphView {
	x: number;
	y: number;
	zoom: number;
}
interface Point {
	x: number;
	y: number;
}

/** Pointer coordinates are local to the graph viewport. */
export class TeamGestures {
	readonly pointers = new Map<number, Point>();
	moved = false;
	private origin: Point = { x: 0, y: 0 };
	private distance = 0;
	private view: GraphView = { x: 0, y: 0, zoom: 1 };
	start(id: number, point: Point, view: GraphView) {
		if (this.pointers.size === 0) this.moved = false;
		this.pointers.set(id, point);
		this.rebase(view);
		if (this.pointers.size > 1) this.moved = true;
	}
	private rebase(view: GraphView) {
		const [first, second] = this.pointers.values();
		this.view = view;
		if (!first) return;
		this.origin = second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first;
		this.distance = second ? Math.hypot(second.x - first.x, second.y - first.y) : 0;
	}
	move(id: number, point: Point): GraphView | undefined {
		if (!this.pointers.has(id)) return;
		this.pointers.set(id, point);
		const [first, second] = this.pointers.values();
		const center = second ? { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 } : first;
		if (!this.moved && Math.hypot(center.x - this.origin.x, center.y - this.origin.y) < 4) return;
		this.moved = true;
		const zoom =
			second && this.distance > 0
				? Math.max(
						0.01,
						Math.min(2, (this.view.zoom * Math.hypot(second.x - first.x, second.y - first.y)) / this.distance),
					)
				: this.view.zoom;
		return {
			zoom,
			x: center.x - ((this.origin.x - this.view.x) * zoom) / this.view.zoom,
			y: center.y - ((this.origin.y - this.view.y) * zoom) / this.view.zoom,
		};
	}
	end(id: number, view: GraphView) {
		this.pointers.delete(id);
		this.rebase(view);
	}
}
