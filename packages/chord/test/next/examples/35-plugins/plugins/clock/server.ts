// The clock plugin's server facet: serves `Clock` with the time its script was evaluated. The example never edits
// this plugin, so a reload leaves it as it is: same script, same facet, same object.

import { Clock } from "@example/contracts/contract";
import { constant, defineFacet } from "@hasilan-code/chord/next";

const evaluatedAt = new Date().toISOString();

export default defineFacet((host) => host.serve(Clock, () => ({ evaluatedAt: constant(evaluatedAt) })));
