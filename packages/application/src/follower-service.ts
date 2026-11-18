import { isValidBalance, type FollowerTrade } from '@copy-trade/domain';
import type { Clock, FollowerRecord, FollowerRepository, IdGenerator } from './ports';

export interface CreateFollowerCommand {
  readonly balance: number;
  readonly allocation: number;
  readonly copyingEnabled: boolean;
}

export type CreateFollowerResult =
  | { readonly ok: true; readonly follower: FollowerRecord }
  | { readonly ok: false; readonly reason: 'INVALID_BALANCE' | 'INVALID_ALLOCATION' };

export interface FollowerServiceDeps {
  readonly followers: FollowerRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly listLimit: number;
}

export class FollowerService {
  readonly #deps: FollowerServiceDeps;

  constructor(deps: FollowerServiceDeps) {
    this.#deps = deps;
  }

  async create(command: CreateFollowerCommand): Promise<CreateFollowerResult> {
    if (!isValidBalance(command.balance)) return { ok: false, reason: 'INVALID_BALANCE' };
    if (!isValidBalance(command.allocation)) return { ok: false, reason: 'INVALID_ALLOCATION' };

    const now = this.#deps.clock.now();
    const follower = await this.#deps.followers.create({
      id: this.#deps.ids.next(),
      balance: command.balance,
      remainingAllocation: command.allocation,
      openingBalance: command.balance,
      openingAllocation: command.allocation,
      copyingEnabled: command.copyingEnabled,
      createdAt: now,
      updatedAt: now,
    });
    return { ok: true, follower };
  }

  get(id: string): Promise<FollowerRecord | undefined> {
    return this.#deps.followers.findById(id);
  }

  list(): Promise<readonly FollowerRecord[]> {
    return this.#deps.followers.list(this.#deps.listLimit);
  }

  setCopyingEnabled(id: string, enabled: boolean): Promise<FollowerRecord | undefined> {
    return this.#deps.followers.setCopyingEnabled(id, enabled, this.#deps.clock.now());
  }

  /** `undefined` when the follower does not exist (distinct from an empty ledger). */
  async listTrades(followerId: string): Promise<readonly FollowerTrade[] | undefined> {
    const follower = await this.#deps.followers.findById(followerId);
    if (follower === undefined) return undefined;
    return this.#deps.followers.listTrades(followerId, this.#deps.listLimit);
  }
}
