import { record } from "../Content.tsx";
import { MetaChips, type ToolDetails, type ToolView } from "./tool-view.tsx";

/**
 * computer: a desktop action is only meaningful with what the screen looked like, so
 * the screenshot is the body. Monitor geometry and release state are chips.
 */
export function computerView({ input, details }: ToolDetails): ToolView {
	const artifact = details && record(details.artifact) && typeof details.artifact.id === "string" ? details.artifact : undefined;
	const screens = Array.isArray(details?.screens) ? details.screens.filter((screen) => record(screen)) : [];
	const action = typeof input?.action === "string" ? input.action : undefined;
	const position = typeof input?.x === "number" && typeof input?.y === "number" ? `${input.x},${input.y}` : undefined;
	return {
		meta: (
			<MetaChips
				items={[
					action,
					typeof details?.monitor === "number" && `monitor ${details.monitor}`,
					typeof details?.width === "number" && typeof details?.height === "number" && `${details.width}×${details.height}`,
					position,
					typeof input?.key === "string" && `key ${input.key}`,
					details?.released === true && "released",
				]}
			/>
		),
		body: (
			<>
				{artifact && (
					<a className="tool-shot" href={`/api/artifacts/${encodeURIComponent(String(artifact.id))}`} target="_blank" rel="noopener noreferrer">
						<img src={`/api/artifacts/${encodeURIComponent(String(artifact.id))}`} alt="Desktop screenshot" />
					</a>
				)}
				{typeof input?.text === "string" && <p className="tool-field"><strong>Text</strong> <code>{input.text}</code></p>}
				{screens.length > 1 && (
					<ul className="tool-file-list">
						{screens.map((screen, index) => (
							<li key={index}>
								<span>Monitor {typeof screen.index === "number" ? screen.index : index + 1}</span>
								<span className="tool-file-kind">{String(screen.width)} × {String(screen.height)}</span>
							</li>
						))}
					</ul>
				)}
			</>
		),
		handlesResult: true,
	};
}
