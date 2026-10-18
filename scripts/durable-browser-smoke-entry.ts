import * as durable from "@hasilan-code/pi-durable";
import * as environment from "@hasilan-code/pi-durable/env";
import * as jsonl from "@hasilan-code/pi-durable/storage/jsonl";
import * as sqlite from "@hasilan-code/pi-durable/storage/sqlite";

// Keep runtime-neutral public entry points live so the browser smoke build
// catches accidental imports of Node-only adapters or built-ins.
console.log(Object.keys(durable), Object.keys(environment), Object.keys(jsonl), Object.keys(sqlite));
