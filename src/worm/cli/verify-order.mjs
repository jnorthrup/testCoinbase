// Lifted from robinhood-worm.js — Python array scissor.
// Full shared imports cloned. DCE later.

export async function verifyOrder(api, orderId, symbol, maxRetries = 6, delayMs = 1500) {
  if (!api || !orderId) return null;
  console.log(`🔍 [Verification] Starting status polling for order: ${orderId} (${symbol})`);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const order = await api.getOrderStatus(orderId);
      if (!order) {
        console.warn(`⚠️ [Verification] Poll attempt ${attempt}/${maxRetries} returned empty response.`);
      } else {
        const state = order.state?.toLowerCase();
        console.log(`   ⏱️ [Verification] Attempt ${attempt}/${maxRetries}: Order State = '${state}'`);

        if (state === "filled") {
          console.log(`   ✅ [Verification] Order ${orderId} is FILLED successfully!`);
          return order;
        }
        if (["rejected", "cancelled", "failed", "expired"].includes(state)) {
          console.error(`   ❌ [Verification] Order ${orderId} failed with state: '${state}'`);
          return null;
        }
      }
    } catch (err) {
      console.error(`   ⚠️ [Verification] Poll attempt ${attempt} error for order ${orderId}:`, err.message);
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  console.error(`   ❌ [Verification] Order ${orderId} polling timed out after ${maxRetries} attempts without confirming execution.`);
  return null;
}