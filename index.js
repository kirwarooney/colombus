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
// SESSION CONFIGURATION
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

// ================================
// PROTECTED ROUTES
// ================================
app.get('/dashboard.html', requireAuth, (req, res) => {
  res.sendFile(__dirname + '/public/dashboard.html');
});

app.get('/settings.html', requireAuth, (req, res) => {
  res.sendFile(__dirname + '/public/settings.html');
});

// ================================
// PUBLIC ROUTES
// ================================
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

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

// ================================
// DATABASE CONNECTION
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

// ================================
// SCHEMAS
// ================================
const orderSchema = new mongoose.Schema({
    hostel: String, room: String, customerName: String, shopName: String,
    phone: String, itemDescription: String, goodsAmount: Number, quantity: Number,
    locationPin: String, latitude: Number, longitude: Number, deliveryFee: Number,
    status: { type: String, default: 'Pending' },
    mpesaReceipt: String, checkoutRequestID: String,
    buniTransactionId: String, buniReceipt: String,
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
// M-PESA (SAFARICOM DARAJA)
// ================================
async function getMpesaAccessToken() {
    const key = process.env.MPESA_CONSUMER_KEY;
    const secret = process.env.MPESA_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
        headers: { Authorization: `Basic ${auth}` }
    });
    return response.data.access_token;
}

app.post('/api/pay', async (req, res) => {
    try {
        const { phone, amount, orderDetails } = req.body;
        const settings = await Settings.findOne();
        const deliveryFee = settings ? settings.deliveryFee : 10;
        
        const newOrder = new Order({
            hostel: orderDetails.hostel, room: orderDetails.room,
            customerName: orderDetails.customerName, shopName: orderDetails.shopName,
            phone: phone, itemDescription: orderDetails.itemDescription,
            goodsAmount: orderDetails.goodsAmount, quantity: orderDetails.quantity,
            locationPin: orderDetails.locationPin,
            latitude: orderDetails.latitude, longitude: orderDetails.longitude,
            deliveryFee: deliveryFee, status: 'Pending', paymentMethod: 'daraja'
        });
        await newOrder.save();
        console.log("📦 Daraja Order saved:", newOrder._id);
        io.emit('new-order', newOrder);

        const token = await getMpesaAccessToken();
        const date = new Date();
        const timestamp = date.getFullYear() + ("0" + (date.getMonth() + 1)).slice(-2) + ("0" + date.getDate()).slice(-2) + ("0" + date.getHours()).slice(-2) + ("0" + date.getMinutes()).slice(-2) + ("0" + date.getSeconds()).slice(-2);
        const shortcode = process.env.MPESA_SHORTCODE;
        const passkey = process.env.MPESA_PASSKEY;
        const password = Buffer.from(shortcode + passkey + timestamp).toString('base64');

        let formattedPhone = phone;
        if (phone.startsWith('0')) formattedPhone = '254' + phone.substring(1);
        else if (phone.startsWith('+')) formattedPhone = phone.substring(1);

        const stkPushData = {
            BusinessShortCode: shortcode, Password: password, Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline", Amount: amount,
            PartyA: formattedPhone, PartyB: shortcode, PhoneNumber: formattedPhone,
            CallBackURL: process.env.MPESA_CALLBACK_URL,
            AccountReference: "ColumbusDelivery", TransactionDesc: "Delivery Fee Payment"
        };

        const response = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', stkPushData, {
            headers: { Authorization: `Bearer ${token}` }
        });

        newOrder.checkoutRequestID = response.data.CheckoutRequestID;
        await newOrder.save();
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("M-Pesa Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "M-Pesa initiation failed." });
    }
});

app.post('/api/callback', async (req, res) => {
    try {
        const callbackData = req.body.Body.stkCallback;
        const checkoutRequestID = callbackData.CheckoutRequestID;
        const resultCode = callbackData.ResultCode;
        if (resultCode === 0) {
            const mpesaReceipt = callbackData.CallbackMetadata.Item.find(item => item.Name === "MpesaReceiptNumber").Value;
            const updatedOrder = await Order.findOneAndUpdate({ checkoutRequestID }, { status: 'Paid', mpesaReceipt }, { new: true });
            if (updatedOrder) io.emit('order-updated', updatedOrder);
        } else {
            const updatedOrder = await Order.findOneAndUpdate({ checkoutRequestID }, { status: 'Failed' }, { new: true });
            if (updatedOrder) io.emit('order-updated', updatedOrder);
        }
    } catch (error) { console.error("Callback error:", error.message); }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// ================================
// KCB BUNI INTEGRATION
// ================================
async function getBuniAccessToken() {
    const key = process.env.BUNI_CONSUMER_KEY;
    const secret = process.env.BUNI_CONSUMER_SECRET;
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const response = await axios.post('https://uat.buni.kcbgroup.com/token?grant_type=client_credentials', {}, {
        headers: { 
            Authorization: `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });
    return response.data.access_token;
}

app.post('/api/buni/pay', async (req, res) => {
    try {
        const { phone, amount, orderDetails } = req.body;
        const settings = await Settings.findOne();
        const deliveryFee = settings ? settings.deliveryFee : 10;
        
        const newOrder = new Order({
            hostel: orderDetails.hostel, room: orderDetails.room,
            customerName: orderDetails.customerName, shopName: orderDetails.shopName,
            phone: phone, itemDescription: orderDetails.itemDescription,
            goodsAmount: orderDetails.goodsAmount, quantity: orderDetails.quantity,
            locationPin: orderDetails.locationPin,
            latitude: orderDetails.latitude, longitude: orderDetails.longitude,
            deliveryFee: deliveryFee, status: 'Pending', paymentMethod: 'buni'
        });
        await newOrder.save();
        console.log("📦 Buni Order saved:", newOrder._id);
        io.emit('new-order', newOrder);

        const token = await getBuniAccessToken();
        
        let formattedPhone = phone;
        if (phone.startsWith('0')) formattedPhone = '254' + phone.substring(1);
        else if (phone.startsWith('+')) formattedPhone = phone.substring(1);

        const buniPayload = {
            phoneNumber: formattedPhone,
            amount: deliveryFee.toString(),
            invoiceNumber: `COLUMBUS-${newOrder._id.toString().slice(-8)}`,
            sharedShortCode: true,
            orgShortCode: process.env.BUNI_ORG_SHORTCODE || '522522',
            orgPassKey: "",
            callbackUrl: process.env.BUNI_CALLBACK_URL,
            transactionDescription: "Delivery Fee Payment"
        };

        const response = await axios.post('https://uat.buni.kcbgroup.com/mm/api/request/1.0.0/stkpush', buniPayload, {
            headers: { 
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });

        newOrder.buniTransactionId = response.data.response.CheckoutRequestID;
        await newOrder.save();

        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("Buni Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ success: false, error: "Buni payment initiation failed." });
    }
});

app.post('/api/buni/ipn', async (req, res) => {
    console.log("KCB Buni IPN Received:", JSON.stringify(req.body, null, 2));
    try {
        const { transactionReference, status, amount } = req.body;
        
        if (status === 'SUCCESS' || status === 'Success') {
            const updatedOrder = await Order.findOneAndUpdate(
                { buniTransactionId: transactionReference },
                { status: 'Paid', buniReceipt: transactionReference },
                { new: true }
            );
            if (updatedOrder) {
                io.emit('order-updated', updatedOrder);
                console.log("✅ Buni order marked as PAID");
            }
        } else {
            const updatedOrder = await Order.findOneAndUpdate(
                { buniTransactionId: transactionReference },
                { status: 'Failed' },
                { new: true }
            );
            if (updatedOrder) io.emit('order-updated', updatedOrder);
            console.log("❌ Buni order payment FAILED");
        }
    } catch (error) {
        console.error("Error processing Buni IPN:", error.message);
    }
    res.status(200).json({ success: true });
});

// ================================
// SETTINGS ENDPOINTS
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
        console.log("⚙️ Settings updated:", settings);
        res.json({ success: true, settings });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// ================================
// CUSTOMER TRACKING
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
        res.json({ success: true, todayVisits, totalVisits, uniqueToday: uniqueIpsToday.length, uniqueTotal: uniqueIpsTotal.length });
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
        const updatedOrder = await Order.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
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
// START SERVER
// ================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server is running on port ${PORT}`));