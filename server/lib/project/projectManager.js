const ba = require('blockapps-rest');
const rest = ba.rest;
const util = ba.common.util;
const config = ba.common.config;
const Promise = ba.common.Promise;
const BigNumber = ba.common.BigNumber;
const constants = ba.common.constants;

const contractName = 'ProjectManager';
const contractFilename = `${config.libPath}/project/contracts/ProjectManager.sol`;

const ErrorCodes = rest.getEnums(`${config.libPath}/common/ErrorCodes.sol`).ErrorCodes;
const ProjectState = ba.rest.getEnums(`${config.libPath}/project/contracts/ProjectState.sol`).ProjectState;
const ProjectEvent = ba.rest.getEnums(`${config.libPath}/project/contracts/ProjectEvent.sol`).ProjectEvent;
const BidState = ba.rest.getEnums(`${config.libPath}/bid/contracts/BidState.sol`).BidState;
const projectContractName = require('./project').contractName;

function* uploadContract(admin, args) {
  const contract = yield rest.uploadContract(admin, contractName, contractFilename, args);
  yield compileSearch(contract);
  contract.src = 'removed';
  return setContract(admin, contract);
}

function setContract(admin, contract) {
  contract.getState = function* () {
    return yield rest.getState(contract);
  }
  contract.createProject = function* (accessToken, args) {
    return yield createProject(accessToken, admin, contract, args);
  }
  contract.getProject = function* (accessToken, name) {
    return yield getProject(accessToken, admin, contract, name);
  }
  contract.getProjects = function* (name) {
    return yield getProjects(contract);
  }
  contract.exists = function* (name) {
    return yield exists(admin, contract, name);
  }
  contract.getProjectsByBuyer = function* (buyer) {
    return yield getProjectsByBuyer(contract, buyer);
  }
  contract.getProjectsBySupplier = function* (supplier) {
    return yield getProjectsBySupplier(contract, supplier);
  }
  contract.getProjectsByName = function* (name) {
    return yield getProjectsByName(contract, name);
  }
  contract.getProjectsByState = function* (state) {
    return yield getProjectsByState(contract, state);
  }
  contract.handleEvent = function* (accessToken, name, projectEvent) {
    return yield handleEvent(accessToken, admin, contract, name, projectEvent);
  }
  contract.createBid = function* (accessToken, name, supplier, amount) {
    return yield createBid(accessToken, admin, contract, name, supplier, amount);
  }
  contract.acceptBid = function* (accessToken, buyer, bidId, name) {
    return yield acceptBid(accessToken, admin, contract, buyer, bidId, name);
  }
  contract.settleProject = function* (accessToken, projectName, supplierAddress, bidAddress) {
    return yield settleProject(accessToken, admin, contract, projectName, supplierAddress, bidAddress);
  }
  contract.getAcceptedBid = getAcceptedBid;

  return contract;
}

function* compileSearch(contract) {
  rest.verbose('compileSearch', contract.codeHash);
  if (yield rest.isSearchable(contract.codeHash)) {
    return;
  }
  // compile dependencies
  const bidJs = require('../bid/bid');
  const userJs = require('../user/user');
  const projectJs = require('./project');
  // compile
  const searchable = [bidJs.contractName, projectJs.contractName, contractName];
  return yield rest.compileSearch(searchable, contractName, contractFilename);
}

// throws: ErrorCodes
// returns: record from search
function* createProject(accessToken, admin, contract, args) {
  rest.verbose('createProject', {admin, args});

  const methodName = 'createProject';
  const result = yield rest.callMethod(accessToken, contract, methodName , args, 0, false);
  const errorCode = parseInt(result[0]);

  if (errorCode !== ErrorCodes.SUCCESS) {
    throw new Error(errorCode);
  }
  // get the contract data from search
  const project = yield getProject(accessToken, admin, contract, args.name);
  return project;
}

// throws: ErrorCodes
// returns: record from search
function* createBid(accessToken, admin, contract, name, supplier, amount) {
  rest.verbose('createBid', {name, supplier, amount});

  const supplierAddress = yield rest.getKey(accessToken);

  const methodName = 'createBid';
  const args = {
    name: name,
    supplier: supplier,
    supplierAddressTemp: supplierAddress.address,
    amount: amount,
  };

  const result = yield rest.callMethod(accessToken, contract, methodName, args, 0, false);
  const errorCode = parseInt(result[0]);

  if (errorCode !== ErrorCodes.SUCCESS) {
    throw new Error(errorCode);
  }
  const bidId = result[1];
  // block until the contract shows up in search
  const bid = (yield rest.waitQuery(`Bid?id=eq.${bidId}`, 1))[0];
  return bid;
}

// throws: ErrorCodes
function* acceptBid(accessToken, admin, contract, buyer, bidId, name) {   // FIXME should go into the contract
  rest.verbose('acceptBid', {admin, buyer, bidId, name});

  const bids = yield getBidsByName(name);
  if (bids.length < 1) {
    throw new Error(ErrorCodes.NOT_FOUND);
  }
  // find the winning bid
  const winningBid = bids.filter(bid => {
    return bid.id === bidId;
  })[0];
  // accept the bid (will transfer funds from buyer to bid contract)
  try {
    yield setBidState(accessToken, buyer, winningBid.address, BidState.ACCEPTED, winningBid.amount);
  } catch (error) {
    // check insufficient balance
    console.log(error.status);
    if (error.status === 400) {
      throw new Error(ErrorCodes.INSUFFICIENT_BALANCE);
    }
    throw error;
  }
  // reject all other bids
  for (let bid of bids) {
    if (bid.id != bidId) {
      yield setBidState(accessToken, buyer, bid.address, BidState.REJECTED, 0); // REJECT
    }
  }
  const result = yield handleEvent(accessToken, admin, contract, name, ProjectEvent.ACCEPT);
  return result;
}

function* setBidState(accessToken, buyer, bidAddress, state, valueEther) {
  rest.verbose('setBidState', {buyer, bidAddress, state, valueEther});

  const contract = {
    name: 'Bid',
    address: bidAddress
  }
  const methodName = 'setBidState';
  const args = {
    newState: state
  };
  const valueWei = new BigNumber(valueEther).mul(constants.ETHER).toFixed();

  const result = yield rest.callMethod(accessToken, contract, methodName, args, valueWei, false);
  const errorCode = parseInt(result[0]);

  if (errorCode !== ErrorCodes.SUCCESS) {
    throw new Error(errorCode);
  }
}

function* settleProject(accessToken, admin, contract, projectName, supplierAddress, bidAddress) {
  rest.verbose('settleProject', {projectName, supplierAddress, bidAddress});

  const methodName = 'settleProject';
  const args = {
    name: projectName,
    supplierAddress: supplierAddress,
    bidAddress: bidAddress,
  };

  const result = yield rest.callMethod(accessToken, contract, methodName, args, 0, false);
  const errorCode = parseInt(result[0]);

  if (errorCode !== ErrorCodes.SUCCESS) {
    throw new Error(errorCode);
  }
}

function* getBid(bidId) {
  rest.verbose('getBid', bidId);
  return (yield rest.waitQuery(`Bid?id=eq.${bidId}`, 1))[0];
}

function* getBidsByName(name) {
  rest.verbose('getBidsByName', name);
  return yield rest.query(`Bid?name=eq.${encodeURIComponent(name)}`);
}

function* getBidsBySupplier(supplier) {
  rest.verbose('getBidsBySupplier', supplier);
  return yield rest.query(`Bid?supplier=eq.${supplier}`);
}

// throws: ErrorCodes
function* getAcceptedBid(projectName) {
  rest.verbose('getAcceptedBid', projectName);
  // get project bids
  const bids = yield getBidsByName(projectName);
  // extract the supplier out of the accepted bid
  const accepted = bids.filter(bid => {
    return parseInt(bid.state) === BidState.ACCEPTED;
  });
  // not found
  if (accepted.length === 0) {
    throw new Error(ErrorCodes.NOT_FOUND);
  }
  // more then one
  if (accepted.length > 1) {
    throw new Error(ErrorCodes.ERROR);
  }
  return accepted[0];
}

function* exists(admin, contract, name) {
  rest.verbose('exists', name);
  // function exists(string name) returns (bool) {
  const method = 'exists';
  const args = {
    name: name,
  };
  const result = yield rest.callMethod(admin, contract, method, args);
  const exists = (result[0] === true);
  return exists;
}

function* getProject(accessToken, admin, contract, name) {
  rest.verbose('getProject', name);

  const methodName = 'getProject';
  const args = {
    name: name,
  };

  const address = (yield rest.callMethod(accessToken, contract, methodName, args, 0, false))[0];

  // if not found - throw
  if (address == 0) {
    throw new Error(ErrorCodes.NOT_FOUND);
  }
  // found - query for the full record
  const project = (yield rest.waitQuery(`${projectContractName}?address=eq.${address}`, 1))[0];
  return project;
}

function* getProjects(contract) {
  rest.verbose('getProjects');
  const state = yield rest.getState(contract);
  const projects = state.projects.slice(1); // remove the first '0000' project
  const csv = util.toCsv(projects); // generate csv string
  const results = yield rest.query(`${projectContractName}?address=in.${csv}`);
  return results;
}

function* getProjectsByBuyer(contract, buyer) {
  rest.verbose('getProjectsByBuyer', buyer);
  const projects = yield getProjects(contract);
  const filtered = projects.filter(function (project) {
    return project.buyer === buyer;
  });
  return filtered;
}

function* getProjectsByState(contract, state) {
  rest.verbose('getProjectsByState', state);
  const projects = yield getProjects(contract);
  const filtered = projects.filter(function (project) {
    return parseInt(project.state) == state;
  });
  return filtered;
}

function* getProjectsBySupplier(contract, supplier) {
  rest.verbose('getProjectsBySupplier', supplier);
  const bids = yield getBidsBySupplier(supplier);
  const names = bids.map(function (bid) {
    return bid.name;
  });
  const projects = yield getProjectsByName(contract, names);
  return projects;
}

function* getProjectsByName(contract, names) {
  rest.verbose('getProjectsByName', names);
  if (names.length == 0) {
    return [];
  }
  // the url might get too long, so the query is broken to multipart
  const MAX = 50; // max names to list in one REST call
  const parts = Math.ceil(names.length / MAX);
  let results = [];
  for (let i = 0; i < parts; i++) {
    const start = i * MAX;
    const end = (i < parts - 1) ? (i + 1) * MAX : names.length;
    const csv = util.toCsv(names.slice(start, end)); // generate csv string
    const partialResults = yield rest.query(`${projectContractName}?name=in.${encodeURIComponent(csv)}`); // get a part
    results = results.concat(partialResults); // add to the results
  }
  return results;
}

function* handleEvent(accessToken, admin, contract, name, projectEvent) {
  rest.verbose('handleEvent', {admin, name, projectEvent});

  const project = yield getProject(accessToken, admin, contract, name);

  const methodName = 'handleEvent';
  const args = {
    projectAddress: project.address,
    projectEvent: projectEvent,
  };

  const result = yield rest.callMethod(accessToken, contract, methodName, args, 0, false);
  const errorCode = parseInt(result[0]);

  if (errorCode !== ErrorCodes.SUCCESS) {
    throw new Error(errorCode);
  }
  const newState = parseInt(result[1]);
  return newState;
}

module.exports = {
  contractName: contractName,
  compileSearch: compileSearch,
  uploadContract: uploadContract,
  setContract: setContract,
  getAcceptedBid: getAcceptedBid,
  getBid: getBid,
  getBidsByName: getBidsByName,
  getBidsBySupplier: getBidsBySupplier,
  getProjectsByState: getProjectsByState,
};
