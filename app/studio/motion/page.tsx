import { redirect } from "next/navigation";
import { connectConsoleUrl } from "../../lib/connect-console";

export default function DeviceConsoleRedirect() {
  redirect(connectConsoleUrl("/studio/motion"));
}
