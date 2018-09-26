const ba = require('blockapps-rest');
const rest = ba.rest;
const util = ba.common.util;
const config = ba.common.config;
const Promise = ba.common.Promise;
const fs = require('fs');
const yaml = require('js-yaml');

const userManagerJs = require(process.cwd() + '/' + config.libPath + '/user/userManager');
const projectManagerJs = require(process.cwd() + '/' + config.libPath + '/project/projectManager');

const ProjectEvent = ba.rest.getEnums(`${config.libPath}/project/contracts/ProjectEvent.sol`).ProjectEvent;
const ErrorCodes = ba.rest.getEnums(`${config.libPath}/common/ErrorCodes.sol`).ErrorCodes;

const contractName = 'AdminInterface';
const contractFilename = '/admin/AdminInterface.sol';
const subContractsNames = ['userManager', 'projectManager'];

function* uploadContract(admin, libPath, chainId) {
  const contract = yield rest.uploadContract(admin, contractName, libPath + contractFilename, {}, chainId);
  contract.src = 'removed';
  yield compileSearch();
  return yield setContract(admin, contract, chainId);
}

function* compileSearch() {
  const libPath = process.cwd() + '/' + config.libPath;
  // compile dependencies
  const bidJs = require(`${libPath}/bid/bid`);
  const userJs = require(`${libPath}/user/user`);
  const projectJs = require(`${libPath}/project/project`);
  // compile
  const searchable = [
    bidJs.contractName,
    projectJs.contractName,
    userJs.contractName,
    userManagerJs.contractName,
    projectManagerJs.contractName,
    contractName
  ];
  yield rest.compileSearch(searchable, contractName, config.libPath + contractFilename)
}

function* getSubContracts(contract, chainId) {
  rest.verbose('getSubContracts', { contract, subContractsNames, chainId });
  const state = yield rest.getState(contract, chainId);
  const subContracts = {}
  subContractsNames.map(name => {
    const address = state[name];
    if (address === undefined || address == 0) throw new Error('Sub contract address not found ' + name);
    subContracts[name] = {
      name: name[0].toUpperCase() + name.substring(1),
      address: address,
    }
  });
  return subContracts;
}

function* setContract(admin, contract, chainId) {
  rest.verbose('setContract', { admin, contract, chainId });
  // set the managers
  const subContarcts = yield getSubContracts(contract, chainId);
  const userManager = userManagerJs.setContract(admin, subContarcts['userManager'], chainId);
  const projectManager = projectManagerJs.setContract(admin, subContarcts['projectManager'], chainId);

  contract.getBalance = function* (username, chainId) {
    rest.verbose('dapp: getBalance', username, chainId);
    return yield userManager.getBalance(username, chainId);
  }
  // project - create
  contract.createProject = function* (args, chainId) {
    return yield createProject(projectManager, args, chainId);
  }
  // project - by name
  contract.getProject = function* (name) {
    rest.verbose('dapp: getProject', name);
    return yield projectManager.getProject(name);
  }
  // projects - by buyer
  contract.getProjectsByBuyer = function* (buyer, chainId) {
    rest.verbose('dapp: getProjectsByBuyer', buyer, chainId);
    return yield projectManager.getProjectsByBuyer(buyer, chainId);
  }
  // projects - by state
  contract.getProjectsByState = function* (state, chainId) {
    rest.verbose('dapp: getProjectsByState', state, chainId);
    return yield projectManager.getProjectsByState(state, chainId);
  }
  // projects - by supplier
  contract.getProjectsBySupplier = function* (supplier, chainId) {
    rest.verbose('dapp: getProjectsBySupplier', supplier, chainId);
    return yield projectManager.getProjectsBySupplier(supplier, chainId);
  }
  // create bid
  contract.createBid = function* (name, supplier, amount) {
    rest.verbose('dapp: createBid', { name, supplier, amount });
    return yield projectManager.createBid(name, supplier, amount);
  }
  // bids by name
  contract.getBids = function* (name) {
    rest.verbose('dapp: getBids', name);
    return yield projectManagerJs.getBidsByName(name);
  }
  // handle event
  contract.handleEvent = function* (args) {
    return yield handleEvent(userManager, projectManager, args);
  }
  // login
  contract.login = function* (username, password, chainId) {
    return yield login(userManager, username, password, chainId);
  }
  // deploy
  contract.deploy = function* (dataFilename, deployFilename, chainId) {
    return yield deploy(admin, contract, userManager, dataFilename, deployFilename, chainId);
  }

  return contract;
}

// =========================== business functions ========================

function* login(userManager, username, password, chainId) {
  rest.verbose('dapp: login', { username, password, chainId });
  const args = { username: username, password: password };
  const result = yield userManager.login(args, chainId);
  // auth failed
  if (!result) {
    return { authenticate: false };
  }
  // auth OK
  const baUser = yield userManager.getUser(username, chainId);
  return { authenticate: true, user: baUser };
}

function* createProject(projectManager, args, chainId) {
  rest.verbose('dapp: createProject', { args });
  args.created = +new Date();
  const project = yield projectManager.createProject(args, chainId);
  return project;
}

// accept bid
function* acceptBid(userManager, projectManager, buyerName, buyerPassword, bidId, projectName) {
  rest.verbose('dapp: acceptBid', { buyerName, buyerPassword, bidId, projectName });
  const buyer = yield userManager.getUser(buyerName);
  buyer.password = buyerPassword;
  const result = yield projectManager.acceptBid(buyer, bidId, projectName);
  return result;
}

// receive project
function* receiveProject(userManager, projectManager, projectName) {
  rest.verbose('dapp: receiveProject', projectName);
  // get the accepted bid
  const bid = yield projectManager.getAcceptedBid(projectName);
  // get the supplier for the accepted bid
  const supplier = yield userManager.getUser(bid.supplier);
  // Settle the project:  change state to RECEIVED and tell the bid to send the funds to the supplier
  const result = yield projectManager.settleProject(projectName, supplier.account, bid.address);
  return result;
}

// handle project event
function* handleEvent(userManager, projectManager, args) {
  const name = args.name;
  rest.verbose('dapp: project handleEvent', args);

  switch (args.projectEvent) {
    case ProjectEvent.RECEIVE:
      return yield receiveProject(userManager, projectManager, args.projectName);

    case ProjectEvent.ACCEPT:
      return yield acceptBid(userManager, projectManager, args.username, args.password, args.bidId, args.projectName);

    default:
      return yield projectManager.handleEvent(args.projectName, args.projectEvent);
  }
}

function* createPresetUsers(userManager, presetUsers, chainId) {
  const UserRole = rest.getEnums(`${config.libPath}/user/contracts/UserRole.sol`).UserRole;
  const users = [];
  for (let presetUser of presetUsers) {
    const args = {
      username: presetUser.username,
      password: presetUser.password,
      role: UserRole[presetUser.role],
    }
    const user = yield userManager.createUser(args, chainId);
    users.push(user);
  }
  return users;
}

function* deploy(admin, contract, userManager, presetDataFilename, deployFilename, chainId) {
  rest.verbose('dapp: deploy', { presetDataFilename, deployFilename });
  const fsutil = ba.common.fsutil;

  const presetData = fsutil.yamlSafeLoadSync(presetDataFilename);
  if (presetData === undefined) throw new Error('Preset data read failed ' + presetDataFilename);
  console.log('Preset data', JSON.stringify(presetData, null, 2));

  // create preset users
  const users = yield createPresetUsers(userManager, presetData.users, chainId);   // TODO test the users are all in

  // TODO: Add users in every chain

  const deployment = {
    [chainId]: {
      url: config.getBlocUrl(),
      admin: admin,
      contract: {
        name: contract.name,
        address: contract.address,
      }
    }
  };
  
  // write
  console.log('deploy filename:', deployFilename);
  console.log(fsutil.yamlSafeDumpSync(deployment));

  const temp = yaml.safeDump(deployment);
  fs.appendFileSync(deployFilename, temp);

  return deployment;
}

module.exports = {
  setContract: setContract,
  compileSearch: compileSearch,
  uploadContract: uploadContract,
};
