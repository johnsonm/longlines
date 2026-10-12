import { runRbnPush } from "../_shared/rbn_push.ts";
import { createRbnPushDb, servePush } from "../_shared/serve.ts";

servePush("rbn", runRbnPush, createRbnPushDb);
