// The notes plugin's server facet: serves `Index` with the same label.

import { Index } from "@example/contracts/contract";
import { constant, defineFacet } from "@hasilan-code/chord/next";
import { label } from "./label.ts";

export default defineFacet((host) => host.serve(Index, () => ({ label: constant(label) })));
