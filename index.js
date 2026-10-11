const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const mongoose = require('mongoose');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// ================================
// SESSION
// ================================
app.use(session({
  secret: process.env.SESSION_SECRET || 'columbus-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, secure: false }
}));

// ================================
// AUTH MIDDLEWARE
// ================================
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'Not authenticated' });
  res.redirect('/login.html');
}

app.get('/dashboard.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));
app.get('/settings.html', requireAuth, (req, res) => res.sendFile(__dirname + '/public/settings.html'));
app.get('/login.html', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/dashboard.html');
  res.sendFile(__dirname + '/public/login.html');
});

// ================================
// VISITOR TRACKING
// ================================
app.use(async (req, res, next) => {
  const publicPaths = ['/', '/index.html', '/track.html'];
  if (req.method === 'GET' && publicPaths.includes(req.path)) {
    try {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = forwarded ? forwarded.split(',')[0].trim() : (req.socket.remoteAddress || 'unknown');
      await Visit.create({ ip, path: req.path });
    } catch (e) { console.error('Visit track error:', e.message); }
  }
  next();
});

app.use(express.static('public'));

// ================================
// LOGIN / LOGOUT
// ================================
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_PASSWORD || 'columbus2026';
  if (password === adminPassword) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' });
  }
});
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/check-auth', (req, res) => res.json({ authenticated: !!(req.session && req.session.authenticated) }));

// ================================
// DATABASE
// ================================
mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    console.log("✅ Connected to MongoDB");
    const existing = await Settings.findOne();
    if (!existing) {
      await Settings.create({
        businessName: 'Columbus Delivery',
        deliveryFee: 10,
        contactPhone: '0719516573',
        footerMessage: 'Fast, reliable campus delivery'
      });
      console.log("⚙️ Default settings created");
    }
  })
  .catch(err => console.error("❌ MongoDB Error:", err.message));

const orderSchema = new mongoose.Schema({
    hostel: String, room: String, customerName: String, shopName: String,
    phone: String, itemDescription: String, goodsAmount: Number, quantity: Number,
    locationPin: String, latitude: Number, longitude: Number, deliveryFee: Number,
    paymentOption: { type: String, default: 'delivery_only' },
    status: { type: String, default: 'Pending' },
    mpesaReceipt: String, checkoutRequestID: String,
    paymentMethod: { type: String, default: 'daraja' },
    createdAt: { type: Date, default: Date.now }
});
const Order = mongoose.model('Order', orderSchema);

const visitSchema = new mongoose.Schema({
    ip: String, path: String, createdAt: { type: Date, default: Date.now }
});
const Visit = mongoose.model('Visit', visitSchema);

const settingsSchema = new mongoose.Schema({
    businessName: { type: String, default: 'Columbus Delivery' },
    deliveryFee: { type: Number, default: 10 },
    contactPhone: { type: String, default: '' },
    footerMessage: { type: String, default: 'Fast, reliable campus delivery' }
});
const Settings = mongoose.model('Settings', settingsSchema);

// ================================
// SOCKET.IO
// ================================
io.on('connection', (socket) => {
    console.log('🟢 WebSocket connected');
    socket.on('disconnect', () => console.log('🔴 WebSocket disconnected'));
});

// ================================
// M-PESA — PRODUCTION (LIVE)
// ================================
const MPESA_BASE = 'https://api.safaricom.co.ke';

async function getMpesaAccessToken() {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    
    console.log("🔑 Requesting M-Pesa Access Token...");
    const response = await axios.get(
        `${MPESA_BASE}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${auth}` } }
    );
    console.log("✅ Access Token received");
    return response.data.access_token;
}

app.post('/api/pay', async (req, res) => {
    try {
        const { phone, amount, orderDetails, paymentOption } = req.body;
        console.log("📥 Incoming payment request:", { phone, amount, paymentOption });

        const settings = await Settings.findOne();
        const deliveryFee = settings ? settings.deliveryFee : 10;
        
        const newOrder = new Order({
            hostel: orderDetails.hostel, room: orderDetails.room,
            customerName: orderDetails.customerName, shopName: orderDetails.shopName,
            phone: phone, itemDescription: orderDetails.itemDescription,
            goodsAmount: orderDetails.goodsAmount, quantity: orderDetails.quantity,
            locationPin: orderDetails.locationPin,
            latitude: orderDetails.latitude, longitude: orderDetails.longitude,
            deliveryFee: deliveryFee, 
            paymentOption: paymentOption || 'delivery_only',
            status: 'Pending', paymentMethod: 'daraja'
        });
        await newOrder.save();
        console.log("📦 Daraja Order saved:", newOrder._id);
        io.emit('new-order', newOrder);

        const token = await getMpesaAccessToken();
        const date = new Date();
        const timestamp = date.getFullYear() + 
            ("0" + (date.getMonth() + 1)).slice(-2) +
            ("0" + date.getDate()).slice(-2) +
            ("0" + date.getHours()).slice(-2) +
            ("0" + date.getMinutes()).slice(-2) +
            ("0" + date.getSeconds()).slice(-2);
        
        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');

        let formattedPhone = phone;
        if (phone.startsWith('0')) formattedPhone = '254' + phone.substring(1);
        else if (phone.startsWith('+')) formattedPhone = phone.substring(1);
        else if (phone.startsWith('254')) formattedPhone = phone;
        else formattedPhone = '254' + phone;

        const stkPushData = {
            BusinessShortCode: shortcode,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerBuyGoodsOnline",
            Amount: amount,
            PartyA: formattedPhone,
            PartyB: shortcode,
            PhoneNumber: formattedPhone,
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            AccountReference: "ColumbusDelivery",
            TransactionDesc: "Delivery Payment"
        };

        console.log("🚀 Sending STK Push to Safaricom...");
        console.log("📤 Payload:", JSON.stringify(stkPushData, null, 2));

        const response = await axios.post(
            `${MPESA_BASE}/mpesa/stkpush/v1/processrequest`,
            stkPushData,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        console.log("✅ Safaricom Response:", JSON.stringify(response.data, null, 2));

        if (response.data && response.data.CheckoutRequestID) {
            newOrder.checkoutRequestID = response.data.CheckoutRequestID;
            await newOrder.save();
        }

        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("❌ M-Pesa Error:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
        res.status(500).json({ 
            success: false, 
            error: "M-Pesa initiation failed. Check server logs.",
            details: error.response ? error.response.data : error.message
        });
    }
});

app.post('/api/callback', async (req, res) => {
    console.log("📞 M-Pesa Callback Received:", JSON.stringify(req.body, null, 2));
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestID = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;
        
        if (resultCode === 0) {
            const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber").Value;
            const updatedOrder = await Order.findOneAndUpdate(
                { checkoutRequestID }, 
                { status: 'Paid', mpesaReceipt }, 
                { new: true }
            );
            if (updatedOrder) io.emit('order-updated', updatedOrder);
            console.log("✅ Order marked as PAID. Receipt:", mpesaReceipt);
        } else {
            const updatedOrder = await Order.findOneAndUpdate(
                { checkoutRequestID }, 
                { status: 'Failed' }, 
                { new: true }
            );
            if (updatedOrder) io.emit('order-updated', updatedOrder);
            console.log("❌ Order payment FAILED. Code:", resultCode);
        }
    } catch (error) { 
        console.error("Callback error:", error.message); 
    }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// ================================
// SETTINGS
// ================================
app.get('/api/settings/public', async (req, res) => {
    try {
        const settings = await Settings.findOne();
        res.json({ 
            success: true, 
            settings: {
                businessName: settings?.businessName || 'Columbus Delivery',
                deliveryFee: settings?.deliveryFee || 10,
                contactPhone: settings?.contactPhone || '',
                footerMessage: settings?.footerMessage || 'Fast, reliable campus delivery'
            }
        });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.get('/api/settings', requireAuth, async (req, res) => {
    try { 
        const settings = await Settings.findOne(); 
        res.json({ success: true, settings }); 
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
    try {
        const { businessName, deliveryFee, contactPhone, footerMessage } = req.body;
        const settings = await Settings.findOneAndUpdate(
            {},
            { businessName, deliveryFee: Number(deliveryFee), contactPhone, footerMessage },
            { new: true, upsert: true }
        );
        res.json({ success: true, settings });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ================================
// TRACKING
// ================================
app.get('/api/track/:phone', async (req, res) => {
    try {
        const phone = req.params.phone;
        let altPhone;
        if (phone.startsWith('254')) altPhone = '0' + phone.substring(3);
        else if (phone.startsWith('0')) altPhone = '254' + phone.substring(1);
        else altPhone = phone;
        const orders = await Order.find({ $or: [{ phone: phone }, { phone: altPhone }] }).sort({ createdAt: -1 });
        res.json({ success: true, orders });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ================================
// VISITS
// ================================
app.get('/api/visits', requireAuth, async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayVisits = await Visit.countDocuments({ createdAt: { $gte: today } });
        const totalVisits = await Visit.countDocuments();
        const uniqueIpsToday = await Visit.distinct('ip', { createdAt: { $gte: today } });
        const uniqueIpsTotal = await Visit.distinct('ip');
        res.json({ 
            success: true, 
            todayVisits, 
            totalVisits, 
            uniqueToday: uniqueIpsToday.length, 
            uniqueTotal: uniqueIpsTotal.length 
        });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ================================
// ADMIN ORDERS
// ================================
app.get('/api/orders', requireAuth, async (req, res) => {
    try { 
        const orders = await Order.find().sort({ createdAt: -1 }); 
        res.json({ success: true, orders }); 
    } catch (error) { res.status(500).json({ success: false }); }
});

app.put('/api/orders/:id/status', requireAuth, async (req, res) => {
    try {
        const updatedOrder = await Order.findByIdAndUpdate(
            req.params.id, 
            { status: req.body.status }, 
            { new: true }
        );
        if (!updatedOrder) return res.status(404).json({ success: false });
        io.emit('order-updated', updatedOrder);
        res.json({ success: true, order: updatedOrder });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.delete('/api/orders/:id', requireAuth, async (req, res) => {
    try {
        const deletedOrder = await Order.findByIdAndDelete(req.params.id);
        if (!deletedOrder) return res.status(404).json({ success: false });
        io.emit('order-deleted', req.params.id);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

// ================================
// START
// ================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📌 MPESA_SHORTCODE: ${process.env.MPESA_SHORTCODE ? '✅ Set' : '❌ MISSING'}`);
    console.log(`📌 MPESA_CONSUMER_KEY: ${process.env.MPESA_CONSUMER_KEY ? '✅ Set' : '❌ MISSING'}`);
    console.log(`📌 MPESA_CONSUMER_SECRET: ${process.env.MPESA_CONSUMER_SECRET ? '✅ Set' : '❌ MISSING'}`);
    console.log(`📌 MPESA_PASSKEY: ${process.env.MPESA_PASSKEY ? '✅ Set' : '❌ MISSING'}`);
    console.log(`📌 MPESA_CALLBACK_URL: ${process.env.MPESA_CALLBACK_URL || '❌ MISSING'}`);
});
