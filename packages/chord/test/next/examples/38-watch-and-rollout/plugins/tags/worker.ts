// The tags plugin's worker facet.

import { labelOf } from "@example/shared/contract";
import { constant, defineFacet } from "@hasilan-code/chord/next";

export default defineFacet((host) => host.serve(labelOf("tags"), () => ({ text: constant("tags on the worker") })));
