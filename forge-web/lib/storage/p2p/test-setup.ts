import { overridePeerReads } from '.'

// No test joins the IPFS network: the browse-source tests stub fetch for the gateways and must
// not have their reads served (or delayed) by a real peer. Tests of the peer path turn it on.
overridePeerReads(false)
