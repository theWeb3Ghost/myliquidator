// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IMorpho {
    struct MarketParams {
        address loanToken;
        address collateralToken;
        address oracle;
        address irm;
        uint256 lltv;
    }

    function liquidate(
        MarketParams calldata marketParams,
        address borrower,
        uint256 seizedAssets,
        uint256 repaidShares,
        bytes calldata data
    ) external returns (uint256, uint256);
}

interface IMorphoLiquidateCallback {
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external;
}

interface IUniswapV3Router {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;           // pool fee, e.g., 3000 = 0.3%
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}


contract MorphoLiquidator is IMorphoLiquidateCallback {
    using SafeERC20 for IERC20;

    address public owner;
    IMorpho public morpho;
    IUniswapV3Router public router;
  

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _morpho, address _router) {
        owner = msg.sender;
        morpho = IMorpho(_morpho);
        router = IUniswapV3Router(_router);
        
    }

   

    /// @notice Start liquidation
    function liquidate(
        IMorpho.MarketParams calldata marketParams,
        address borrower,
        uint256 repaidShares
    ) external onlyOwner {
        // IMPORTANT: data must be non-empty to trigger callback
        bytes memory data = abi.encode(
            marketParams.collateralToken,
            marketParams.loanToken
        );

        morpho.liquidate(
            marketParams,
            borrower,
            0,              
            repaidShares,
            data
        );
    }

    /// @notice Called by Morpho AFTER collateral is sent, BEFORE repayment
    function onMorphoLiquidate(uint256 repaidAssets, bytes calldata data) external {
        require(msg.sender == address(morpho), "Only Morpho");

        (address collateralToken, address loanToken) =
            abi.decode(data, (address, address));

        IERC20 collateral = IERC20(collateralToken);
        IERC20 loan = IERC20(loanToken);

        uint256 collateralBal = collateral.balanceOf(address(this));
        require(collateralBal > 0, "No collateral");

        // Swap collateral → loan token
        collateral.safeIncreaseAllowance(address(router), collateralBal);

       


      IUniswapV3Router.ExactInputSingleParams memory params = IUniswapV3Router.ExactInputSingleParams({
        tokenIn: collateralToken,
        tokenOut: loanToken,
        fee: 3000,                  
        recipient: address(this),
        deadline: block.timestamp,
        amountIn: collateralBal,
        amountOutMinimum: 0      
        sqrtPriceLimitX96: 0
    });

    uint256 amountOut = router.exactInputSingle(params);
    require(amountOut >= repaidAssets, "Unprofitable liquidation");
        // Approve Morpho to pull repayment
        loan.safeIncreaseAllowance(address(morpho), repaidAssets);
    }

    /// @notice Withdraw profits
    function withdraw(address token) external onlyOwner {
        uint256 bal = IERC20(token).balanceOf(address(this));
        require(bal > 0, "No balance");
        IERC20(token).safeTransfer(owner, bal);
    }
}