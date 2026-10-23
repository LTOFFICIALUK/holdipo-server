// The pump.fun SDK's ESM build imports a CommonJS package by name, which Node
// rejects. Loading its CommonJS build avoids that.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sdk = require("@pump-fun/pump-sdk") as typeof import("@pump-fun/pump-sdk");

export const PUMP_SDK = sdk.PUMP_SDK;
export const OnlinePumpSdk = sdk.OnlinePumpSdk;
export const bondingCurvePda = sdk.bondingCurvePda;
export const PUMP_PROGRAM_ID = sdk.PUMP_PROGRAM_ID;
