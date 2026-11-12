/* @ts-self-types="./eq_bridge.d.ts" */
import * as wasm from "./eq_bridge_bg.wasm";
import { __wbg_set_wasm } from "./eq_bridge_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    curve_db, design_error
} from "./eq_bridge_bg.js";
