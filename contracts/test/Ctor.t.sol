// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {NO_PERMIT2} from "./Mocks.sol";
import {strayConfig, singleConfig} from "./Fees.sol";

/**
 * @notice Deploys through a plain CREATE.
 *
 * forge rewrites `new C(...)` written inside a test into a cheatcode, and the coverage counters of
 * a constructor that reverts in that frame are lost (see `ExecutorFactory`). Going through a
 * contract keeps the CREATE ordinary, so the guards below are counted. Nothing else differs.
 */
contract CtorFactory {
    function settlement(FeeConfig.Config memory stray, address permit2) external returns (address) {
        return address(new ProveSettlement(stray, permit2));
    }

    function defaults(address initialOwner) external returns (address) {
        return address(new FeeDefaults(initialOwner));
    }
}

contract CtorTest is Test {
    CtorFactory factory = new CtorFactory();

    function test_TheSettlementNeedsAPermit2Address() public {
        (bool ok, bytes memory ret) = address(factory)
            .call(abi.encodeCall(CtorFactory.settlement, (strayConfig(), address(0))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(ProveSettlement.BadParameter.selector));
    }

    function test_TheSettlementDeploysWithAValidStrayConfig() public {
        address s = factory.settlement(strayConfig(), NO_PERMIT2);
        assertGt(s.code.length, 0);
        assertTrue(ProveSettlement(s).relayer() != address(0));
    }

    function test_TheStrayConfigMayNotNameTheSettlementItself() public {
        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));
        (bool ok, bytes memory ret) = address(factory)
            .call(abi.encodeCall(CtorFactory.settlement, (singleConfig(predicted), NO_PERMIT2)));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.ReservedDestination
            )
        );
    }

    function test_FeeDefaultsNeedsAnOwner() public {
        (bool ok, bytes memory ret) =
            address(factory).call(abi.encodeCall(CtorFactory.defaults, (address(0))));
        assertFalse(ok);
        assertEq(ret, abi.encodeWithSelector(FeeDefaults.BadParameter.selector));
        assertGt(factory.defaults(address(0xA11CE)).code.length, 0);
    }
}
