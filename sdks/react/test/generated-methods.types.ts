import {
  METHODS,
  type AvailableArgs,
  type GetStreamArgs,
  type IndexRole,
  type Stream,
  type WithdrawArgs,
  type WithdrawMaxArgs,
} from "@streampay/sdk";
import { useAccrual, useStream, useStreams, useWithdraw } from "../src/index.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Assert<Value extends true> = Value;

type StreamIdCoverage = Assert<Equal<Parameters<typeof useStream>[0], GetStreamArgs["streamId"]>>;
type AccrualIdCoverage = Assert<Equal<Parameters<typeof useAccrual>[0], AvailableArgs["streamId"]>>;
type WithdrawIdCoverage = Assert<Equal<Parameters<typeof useWithdraw>[0], WithdrawMaxArgs["streamId"]>>;
type WithdrawAmountCoverage = Assert<Equal<Parameters<ReturnType<typeof useWithdraw>["withdraw"]>[0], WithdrawArgs["amount"]>>;
type StreamsRoleCoverage = Assert<Equal<Parameters<typeof useStreams>[0], IndexRole>>;
type StreamResultCoverage = Assert<Equal<ReturnType<typeof useStream>, Stream>>;

type RequiredMethods =
  | "getStream"
  | "available"
  | "withdraw"
  | "withdrawMax"
  | "senderStreams"
  | "recipientStreams";
type MethodCoverage = Assert<RequiredMethods extends keyof typeof METHODS ? true : false>;

export type GeneratedMethodCoverage =
  | StreamIdCoverage
  | AccrualIdCoverage
  | WithdrawIdCoverage
  | WithdrawAmountCoverage
  | StreamsRoleCoverage
  | StreamResultCoverage
  | MethodCoverage;
