import type { Provider } from "@crosstalk/shared";
import type { AgentDriver, DriverContext, DriverFactory } from "./driver";
import { MockDriver } from "./mock";

const factories = new Map<Provider, DriverFactory>();
factories.set("mock", (ctx) => new MockDriver(ctx));

export function registerDriver(p: Provider, f: DriverFactory) {
  factories.set(p, f);
}

export function createDriver(ctx: DriverContext): AgentDriver {
  const f = factories.get(ctx.member.provider);
  if (!f) throw new Error(`${ctx.member.provider} isn't supported yet`);
  return f(ctx);
}
