const axios = require('axios');

async function test() {
  try {
    // Register
    const email = `test-${Date.now()}@example.com`;
    console.log(`Registering ${email}`);
    await axios.post('http://localhost:3000/api/v1/auth/register', {
      email,
      password: 'Password123!'
    });
    
    console.log(`Bypassing OTP in DB...`);
    const { execSync } = require('child_process');
    execSync(`PGPASSWORD=postgres psql -U postgres -h localhost -d fx_exchange -c "UPDATE users SET \\"isVerified\\" = true WHERE email = '${email}'"`);

    // Login
    const loginRes = await axios.post('http://localhost:3000/api/v1/auth/login', {
      email,
      password: 'Password123!'
    });
    
    const token = loginRes.data?.data?.accessToken || loginRes.data?.data?.token || loginRes.data?.accessToken;
    console.log('Got token');
    
    // Fund Wallet
    await axios.post('http://localhost:3000/api/v1/wallet/fund', {
      currency: 'NGN',
      amount: 50000
    }, {
      headers: { Authorization: `Bearer ${token}`, 'x-idempotency-key': `fund-${Date.now()}` }
    });
    console.log('Funded wallet');

    // Get Transactions
    const txRes = await axios.get('http://localhost:3000/api/v1/wallet/transactions', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log("RESPONSE:", JSON.stringify(txRes.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error("API ERROR:", err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

test();
