// Type-level test, checked by `pnpm typecheck`: the real SDK client must plug into JevClassifier without a cast.
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { JevClassifier } from "../../src/index.ts";

new JevClassifier({ client: new TypeSafeClient({ apiKey: "type-check-only" }) });
