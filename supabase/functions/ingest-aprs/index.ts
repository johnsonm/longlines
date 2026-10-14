import { runAprsPush } from "../_shared/aprs.ts";
import { createAprsPushDb, servePush } from "../_shared/serve.ts";

servePush("aprs", runAprsPush, createAprsPushDb);
