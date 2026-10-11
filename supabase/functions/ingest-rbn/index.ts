import { runRbnPush } from "../_shared/rbn_push.ts";
import { servePush } from "../_shared/serve.ts";

servePush("rbn", runRbnPush);
