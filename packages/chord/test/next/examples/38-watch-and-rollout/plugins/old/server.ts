// The old plugin's server facet; the example deletes the plugin's directory.

import { labelOf } from "@example/shared/contract";
import { constant, defineFacet } from "@hasilan-code/chord/next";

export default defineFacet((host) => host.serve(labelOf("old"), () => ({ text: constant("old on the server") })));
