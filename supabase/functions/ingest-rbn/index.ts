import { rbnAdapter } from "../_shared/rbn.ts";
import { servePush } from "../_shared/serve.ts";

servePush("rbn", rbnAdapter);
