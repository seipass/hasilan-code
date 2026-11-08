// The ruler plugin's server facet: imports a file of the shapes plugin that imports a package. Refused at build: a
// copied file may import only host packages and files of its own plugin.

import { Millimetres } from "@example/shapes/units";
import { defineFacet } from "@hasilan-code/chord/next";

export default defineFacet(() => {
	console.log(Millimetres);
});
