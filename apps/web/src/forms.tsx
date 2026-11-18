import type { CopyTradeRequest, CreateFollowerRequest } from '@copy-trade/contracts';
import { useState, type SubmitEvent } from 'react';

const toInt = (value: string): number => Number.parseInt(value, 10);

export function CreateFollowerForm(props: {
  disabled: boolean;
  onSubmit: (body: CreateFollowerRequest) => Promise<void>;
}) {
  const [balance, setBalance] = useState('10000');
  const [allocation, setAllocation] = useState('2000');
  const [copyingEnabled, setCopyingEnabled] = useState(true);

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    void props.onSubmit({ balance: toInt(balance), allocation: toInt(allocation), copyingEnabled });
  };

  return (
    <form className="form" onSubmit={submit} aria-label="Create follower">
      <label>
        Balance
        <input
          name="balance"
          inputMode="numeric"
          value={balance}
          onChange={(e) => {
            setBalance(e.target.value);
          }}
        />
      </label>
      <label>
        Allocation
        <input
          name="allocation"
          inputMode="numeric"
          value={allocation}
          onChange={(e) => {
            setAllocation(e.target.value);
          }}
        />
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={copyingEnabled}
          onChange={(e) => {
            setCopyingEnabled(e.target.checked);
          }}
        />
        Copying enabled
      </label>
      <button type="submit" disabled={props.disabled}>
        Create follower
      </button>
    </form>
  );
}

export function TradeForm(props: {
  followerId: string;
  disabled: boolean;
  onSubmit: (body: CopyTradeRequest, idempotencyKey?: string) => Promise<void>;
}) {
  const [tradeId, setTradeId] = useState(() => `trade-${crypto.randomUUID().slice(0, 8)}`);
  const [traderId, setTraderId] = useState('trader-demo');
  const [amount, setAmount] = useState('700');
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const submit = (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    const key = idempotencyKey.trim();
    void props.onSubmit(
      { trade: { id: tradeId, traderId, amount: toInt(amount) }, followerId: props.followerId },
      key === '' ? undefined : key,
    );
  };

  return (
    <form className="form" onSubmit={submit} aria-label="Submit trade">
      <label>
        Trade id
        <input
          name="tradeId"
          value={tradeId}
          onChange={(e) => {
            setTradeId(e.target.value);
          }}
        />
      </label>
      <label>
        Trader id
        <input
          name="traderId"
          value={traderId}
          onChange={(e) => {
            setTraderId(e.target.value);
          }}
        />
      </label>
      <label>
        Amount
        <input
          name="amount"
          inputMode="numeric"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
          }}
        />
      </label>
      <label>
        Idempotency-Key (optional)
        <input
          name="idempotencyKey"
          value={idempotencyKey}
          onChange={(e) => {
            setIdempotencyKey(e.target.value);
          }}
        />
      </label>
      <div className="row">
        <button type="submit" disabled={props.disabled}>
          Submit trade
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setTradeId(`trade-${crypto.randomUUID().slice(0, 8)}`);
          }}
        >
          New trade id
        </button>
      </div>
    </form>
  );
}
