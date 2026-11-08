// The notes plugin's worker facet: its label.

import { labelOf } from "@example/shared/contract";
import { constant, defineFacet } from "@hasilan-code/chord/next";
import { label } from "./label.ts";

export default defineFacet((host) =>
	host.serve(labelOf("notes"), () => ({ text: constant(`${label} on the worker`) })),
);
