// Keep the legacy/dev entry on the CLI's workspace and shutdown lifecycle.
import { main } from "../cli.js";
main(["studio"]).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error("Rea: " + error.message);
    process.exitCode = 2;
  },
);
