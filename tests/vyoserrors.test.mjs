import { test } from "node:test";
import assert from "node:assert/strict";
import { explainError, withExplanation } from "../src/lib/vyoserrors.js";

// real messages from VyOS (lab router)
test("VyOS refusals in plain words", () => {
  assert.match(explainError("Error: 300.1.1.1/24 is not a valid network interface address\nInvalid value\nValue validation failed\nSet failed"), /didn't accept "300\.1\.1\.1\/24"/);
  assert.match(explainError("Configuration path: [interfaces ethernet eth9 foo x] is not valid\nSet failed"), /no setting "interfaces ethernet eth9 foo x"/);
  assert.match(explainError("[ service dhcp-server ]\nDHCP range \"0\" stop address not within shared-network \"OFFICE,\n[[service dhcp-server]] failed\nCommit failed"), /last address isn't inside the network/);
  assert.match(explainError("[ service dhcp-server ]\nDHCP range \"0\" stop address must be greater or equal\n[[service dhcp-server]] failed\nCommit failed"), /ends before it starts/);
  assert.match(explainError("[ nat ]\nSource NAT configuration error in rule 999: translation requires address\n[[nat]] failed\nCommit failed"), /needs an address/);
  assert.match(explainError("Invalid value\nValue validation failed\nSet failed"), /check its format/);
});

test("no reason given: names the part and where to look", () => {
  const t = explainError("[ interfaces wireguard wg9 ]\n\n[[interfaces wireguard wg9]] failed\nCommit failed");
  assert.match(t, /refused the change to "interfaces wireguard wg9" without saying why/);
  assert.match(t, /Advanced → VPN/);
});

test("connection errors; VyGi's own messages untouched", () => {
  assert.match(explainError("error sending request: tcp connect error: No route to host (os error 113)"), /can't reach the router/);
  assert.match(explainError("error trying to connect: Connection refused (os error 111)"), /refused the connection/);
  assert.equal(explainError("API key rejected: check the key in More options."), null);
  assert.equal(withExplanation("Cancelled: nothing was changed."), "Cancelled: nothing was changed.");
  assert.match(withExplanation("Invalid value\nSet failed"), /\n\nVyOS said:\nInvalid value/);
});
