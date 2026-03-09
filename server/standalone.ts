import { startServer } from "./index";

startServer({
  port: Number(process.env.PORT || 8787),
  preferRandomPortOnBusy: false
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
