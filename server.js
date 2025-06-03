const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");
const lockfile = require("proper-lockfile");
const ExcelJS = require('exceljs');
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const CARTS_FILE = path.join(__dirname, 'carts.json');
const PRODUCTS_FILE = path.join(__dirname, "products.json");
const ORDERS_FILE = path.join(__dirname, "orders.json");
const UPLOADS_DIR = path.join(__dirname, "uploads");
const ALLOWED_BRANDS = ["Cartier", "Bvlgari", "Van Cleef & Arpels", "Chrome Hearts", "GKH Jewelry"];
const ALLOWED_TYPES = ["Nhẫn", "Dây chuyền", "Vòng tay", "Vòng cổ", "Khuyên tai"];
const ALLOWED_MATERIALS = ["18K Gold", "24K Gold", "925 Silver", "Platinum", "Diamond"];

// Middleware
app.use(cors());
app.use(express.json());
app.use("/backend/uploads", express.static(UPLOADS_DIR, {
    setHeaders: (res, path) => {
        console.log(`Serving file: ${path}`);
    }
}));
app.use(express.static(path.join(__dirname, "public")));

// Multer configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    },
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        if (!file) {
            console.log("File filter: No file provided");
            return cb(new Error("No image file provided"), false);
        }
        const filetypes = /jpeg|jpg|png/;
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);
        if (extname && mimetype) {
            console.log("File filter: Valid image file", { name: file.originalname, type: file.mimetype, size: file.size });
            return cb(null, true);
        }
        console.log("File filter: Invalid file type", { name: file.originalname, type: file.mimetype });
        cb(new Error("Only jpg, jpeg, and png files are allowed"), false);
    },
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
});

async function backupProductsFile() {
    const backupPath = path.join(__dirname, `products_backup_${Date.now()}.json`);
    await fs.copyFile(PRODUCTS_FILE, backupPath);
    console.log(`Backup created: ${backupPath}`);
}

async function cleanProductsFile() {
    try {
        const data = await fs.readFile(PRODUCTS_FILE, 'utf8');
        let products = JSON.parse(data);
        products = products.map(p => ({
            ...p,
            name: p.name.trim(),
            brand: p.brand.trim(),
            type: p.type.trim(),
            material: p.material.trim()
        }));
        await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
        console.log('Cleaned products.json');
    } catch (err) {
        console.error('Error cleaning products.json:', err);
    }
}

// Run cleanup once on server start
cleanProductsFile();

async function withFileLock(operation, callback) {
    console.log(`Starting operation: ${operation}`);
    try {
        const release = await lockfile.lock(PRODUCTS_FILE, { retries: 10 });
        try {
            return await callback();
        } finally {
            await release();
            console.log(`Completed operation: ${operation}`);
        }
    } catch (err) {
        console.error(`File lock error for ${operation}:`, err);
        throw err;
    }
}

// JWT verification middleware
function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        console.log("Token verification: No token provided");
        return res.status(401).json({ message: "No token provided" });
    }
    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        console.error("Token verification error:", err);
        res.status(401).json({ message: "Invalid token" });
    }
}

// Login route
app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    console.log("Login attempt:", { username });
    if (
        username !== process.env.ADMIN_USERNAME ||
        !(await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH))
    ) {
        console.log("Login failed: Invalid credentials");
        return res.status(401).json({ message: "Invalid username or password" });
    }
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: "1h" });
    console.log("Login successful:", { username });
    res.json({ success: true, token });
});

// Get all products
app.get("/api/products", async (req, res) => {
    try {
        const data = await fs.readFile(PRODUCTS_FILE, "utf8");
        const products = JSON.parse(data);
        console.log("Products fetched:", products);
        res.json(products);
    } catch (err) {
        console.error("Error reading products:", err);
        res.status(500).json({ message: "Error reading products" });
    }
});

// Get specific product
app.get("/api/products/:name/:brand/:material", async (req, res) => {
    const { name, brand, material } = req.params;
    const decodedName = decodeURIComponent(name);
    const decodedBrand = decodeURIComponent(brand);
    const decodedMaterial = decodeURIComponent(material);
    console.log("Fetching product:", { name: decodedName, brand: decodedBrand, material: decodedMaterial });
    try {
        const data = await fs.readFile(PRODUCTS_FILE, "utf8");
        const products = JSON.parse(data);
        console.log("Products in file:", products);
        const product = products.find(
            p => p.name === decodedName &&
                p.brand === decodedBrand &&
                p.material === decodedMaterial
        );
        if (!product) {
            console.log("Product not found:", { name: decodedName, brand: decodedBrand, material: decodedMaterial });
            return res.status(404).json({ message: `Product not found: ${decodedName}, ${decodedBrand}, ${decodedMaterial}` });
        }
        res.json(product);
    } catch (err) {
        console.error("Error reading product:", err);
        res.status(500).json({ message: "Error reading product" });
    }
});

// Upload Excel file
app.post('/api/upload-excel', verifyToken, upload.single('excel'), async (req, res) => {
    try {
        if (!req.file) {
            console.log("Validation failed: No Excel file provided");
            return res.status(400).json({ message: 'No Excel file provided' });
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const worksheet = workbook.getWorksheet(1);
        const data = [];

        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return;
            data.push({
                Name: row.getCell(1).value,
                Brand: row.getCell(2).value,
                Type: row.getCell(3).value,
                Stock: row.getCell(4).value,
                OriginalPrice: row.getCell(5).value,
                SalePrice: row.getCell(6).value,
                Image: row.getCell(7).value,
                Material: row.getCell(8).value
            });
        });

        for (const product of data) {
            if (!product.Name || !product.Brand || !product.Type || !product.Stock ||
                product.OriginalPrice == null || !product.Material || !product.Image) {
                console.log("Validation failed: Missing fields in Excel data", product);
                return res.status(400).json({ message: 'Missing required fields in Excel data' });
            }

            const normalizedBrand = product.Brand?.toString().trim();
            const normalizedType = product.Type?.toString().trim();
            const normalizedMaterial = product.Material?.toString().trim();

            if (!ALLOWED_BRANDS.includes(normalizedBrand)) {
                return res.status(400).json({
                    message: `Invalid brand: "${normalizedBrand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}`
                });
            }
            if (!ALLOWED_TYPES.includes(normalizedType)) {
                return res.status(400).json({
                    message: `Invalid type: "${normalizedType}". Must be one of: ${ALLOWED_TYPES.join(", ")}`
                });
            }
            if (!ALLOWED_MATERIALS.includes(normalizedMaterial)) {
                return res.status(400).json({
                    message: `Invalid material: "${normalizedMaterial}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}`
                });
            }

            const parsedStock = parseInt(product.Stock);
            const parsedOriginalPrice = parseFloat(product.OriginalPrice);
            const parsedSalePrice = parseFloat(product.SalePrice);

            if (
                isNaN(parsedStock) || parsedStock < 0 ||
                isNaN(parsedOriginalPrice) || parsedOriginalPrice < 0 ||
                isNaN(parsedSalePrice) || parsedSalePrice < 0
            ) {
                return res.status(400).json({ message: 'Invalid numeric fields in Excel data' });
            }
        }

        const result = await withFileLock('upload_excel', async () => {
            let products = [];
            try {
                const data = await fs.readFile(PRODUCTS_FILE, "utf8");
                products = JSON.parse(data);
            } catch (err) {
                console.error("Error reading products.json:", err);
            }

            const newProducts = data.map(product => ({
                name: product.Name.toString().trim(),
                brand: product.Brand.toString().trim(),
                type: product.Type.toString().trim(),
                stock: parseInt(product.Stock),
                imageUrl: product.Image.toString().trim(),
                originalPrice: parseFloat(product.OriginalPrice),
                salePrice: parseFloat(product.SalePrice),
                material: product.Material.toString().trim()
            }));

            for (const newProduct of newProducts) {
                if (products.some(p => p.name === newProduct.name && p.brand === newProduct.brand && p.material === newProduct.material)) {
                    throw new Error(`Duplicate product: ${newProduct.name}, ${newProduct.brand}, ${newProduct.material}`);
                }
            }

            products = [...products, ...newProducts];
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            return newProducts;
        });

        console.log("Excel processed and saved:", result);
        res.json({ message: 'Excel file processed successfully', products: result });
    } catch (err) {
        console.error('Error processing Excel file:', err);
        res.status(500).json({ message: err.message || 'Error processing Excel file' });
    }
});

// Add a new product
app.post("/api/products", verifyToken, upload.single("image"), async (req, res) => {
    try {
        const { name, brand, type, stock, originalPrice, salePrice, material } = req.body;
        console.log("Received FormData for new product:", {
            name,
            brand,
            type,
            stock,
            originalPrice,
            salePrice,
            material,
            image: req.file ? req.file.filename : "No image"
        });

        if (!name || !brand || !type || !stock || !originalPrice || !material || !req.file) {
            console.log("Validation failed: Missing required fields", { name, brand, type, stock, originalPrice, material, file: !!req.file });
            return res.status(400).json({ message: "All fields are required, including a jpg or png image file and material" });
        }

        const normalizedBrand = brand.trim();
        const normalizedType = type.trim();
        const normalizedMaterial = material.trim();

        if (!ALLOWED_BRANDS.includes(normalizedBrand)) {
            console.log("Validation failed: Invalid brand", normalizedBrand);
            return res.status(400).json({
                message: `Invalid brand: "${normalizedBrand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}`
            });
        }
        if (!ALLOWED_TYPES.includes(normalizedType)) {
            console.log("Validation failed: Invalid type", normalizedType);
            return res.status(400).json({
                message: `Invalid type: "${normalizedType}". Must be one of: ${ALLOWED_TYPES.join(", ")}`
            });
        }
        if (!ALLOWED_MATERIALS.includes(normalizedMaterial)) {
            console.log("Validation failed: Invalid material", normalizedMaterial);
            return res.status(400).json({
                message: `Invalid material: "${normalizedMaterial}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}`
            });
        }

        const parsedStock = parseInt(stock);
        const parsedOriginalPrice = parseFloat(originalPrice);
        const parsedSalePrice = parseFloat(salePrice || "0");

        console.log("Parsed values:", { parsedStock, parsedOriginalPrice, parsedSalePrice });

        if (
            isNaN(parsedStock) || parsedStock < 0 ||
            isNaN(parsedOriginalPrice) || parsedOriginalPrice < 0 ||
            isNaN(parsedSalePrice) || parsedSalePrice < 0
        ) {
            console.log("Validation failed: Invalid numeric fields");
            return res.status(400).json({ message: "Invalid numeric fields" });
        }

        const newProduct = await withFileLock("add_product", async () => {
            let products = [];
            try {
                const data = await fs.readFile(PRODUCTS_FILE, "utf8");
                products = JSON.parse(data);
            } catch (err) {
                console.error("Error reading products.json:", err);
            }

            if (products.some(p => p.name === name.trim() && p.brand === normalizedBrand && p.material === normalizedMaterial)) {
                throw new Error(`Product already exists: ${name.trim()}, ${normalizedBrand}, ${normalizedMaterial}`);
            }

            const newProduct = {
                name: name.trim(),
                brand: normalizedBrand,
                type: normalizedType,
                stock: parsedStock,
                imageUrl: `/backend/uploads/${req.file.filename}`,
                originalPrice: parsedOriginalPrice,
                salePrice: parsedSalePrice,
                material: normalizedMaterial
            };
            products.push(newProduct);
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            return newProduct;
        });

        console.log("Product added:", newProduct);
        res.status(201).json(newProduct);
    } catch (err) {
        console.error("Error adding product:", err);
        res.status(400).json({ message: err.message || "Error adding product" });
    }
});

// Update product
app.patch("/api/products/:name/:brand/:material", verifyToken, upload.single("image"), async (req, res) => {
    const { name, brand, material } = req.params;
    const decodedName = decodeURIComponent(name);
    const decodedBrand = decodeURIComponent(brand);
    const decodedMaterial = decodeURIComponent(material);
    const { stock, originalPrice, salePrice, newMaterial, newName, newBrand, newType } = req.body;
    console.log("Updating product:", { 
        name: decodedName, 
        brand: decodedBrand, 
        material: decodedMaterial, 
        stock, 
        originalPrice, 
        salePrice, 
        newMaterial, 
        newName, 
        newBrand, 
        newType, 
        image: req.file ? req.file.filename : "No image" 
    });

    try {
        const updates = {};
        if (stock !== undefined) {
            const parsedStock = parseInt(stock);
            if (isNaN(parsedStock) || parsedStock < 0) {
                return res.status(400).json({ message: "Invalid stock value" });
            }
            updates.stock = parsedStock;
        }
        if (originalPrice !== undefined) {
            const parsedOriginalPrice = parseFloat(originalPrice);
            if (isNaN(parsedOriginalPrice) || parsedOriginalPrice < 0) {
                return res.status(400).json({ message: "Invalid original price value" });
            }
            updates.originalPrice = parsedOriginalPrice;
        }
        if (salePrice !== undefined) {
            const parsedSalePrice = parseFloat(salePrice);
            if (isNaN(parsedSalePrice) || parsedSalePrice < 0) {
                return res.status(400).json({ message: "Invalid sale price value" });
            }
            updates.salePrice = parsedSalePrice;
        }
        if (newMaterial !== undefined) {
            const normalizedMaterial = newMaterial.trim();
            if (!ALLOWED_MATERIALS.includes(normalizedMaterial)) {
                console.log("Validation failed: Invalid material", normalizedMaterial);
                return res.status(400).json({
                    message: `Invalid material: "${normalizedMaterial}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}`
                });
            }
            updates.material = normalizedMaterial;
        }
        if (newName !== undefined) {
            const normalizedName = newName.trim();
            if (!normalizedName) {
                return res.status(400).json({ message: "Invalid name value" });
            }
            updates.name = normalizedName;
        }
        if (newBrand !== undefined) {
            const normalizedBrand = newBrand.trim();
            if (!ALLOWED_BRANDS.includes(normalizedBrand)) {
                console.log("Validation failed: Invalid brand", normalizedBrand);
                return res.status(400).json({
                    message: `Invalid brand: "${normalizedBrand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}`
                });
            }
            updates.brand = normalizedBrand;
        }
        if (newType !== undefined) {
            const normalizedType = newType.trim();
            if (!ALLOWED_TYPES.includes(normalizedType)) {
                console.log("Validation failed: Invalid type", normalizedType);
                return res.status(400).json({
                    message: `Invalid type: "${normalizedType}". Must be one of: ${ALLOWED_TYPES.join(", ")}`
                });
            }
            updates.type = normalizedType;
        }
        if (req.file) {
            updates.imageUrl = `/backend/uploads/${req.file.filename}`;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" });
        }

        const result = await withFileLock(`update_product_${decodedName}_${decodedBrand}_${decodedMaterial}`, async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            let products = JSON.parse(data);
            console.log("Products in file:", products);
            const productIndex = products.findIndex(p =>
                p.name === decodedName &&
                p.brand === decodedBrand &&
                p.material === decodedMaterial
            );
            if (productIndex === -1) {
                console.log("Product not found:", { name: decodedName, brand: decodedBrand, material: decodedMaterial });
                return { error: `Product not found: ${decodedName}, ${decodedBrand}, ${decodedMaterial}` };
            }

            const updatedName = updates.name || products[productIndex].name;
            const updatedBrand = updates.brand || products[productIndex].brand;
            const updatedMaterial = updates.material || products[productIndex].material;
            if (products.some((p, i) =>
                i !== productIndex &&
                p.name === updatedName &&
                p.brand === updatedBrand &&
                p.material === updatedMaterial
            )) {
                throw new Error(`Duplicate product: ${updatedName}, ${updatedBrand}, ${updatedMaterial}`);
            }

            products[productIndex] = { ...products[productIndex], ...updates };
            if (updates.stock === 0) {
                products.splice(productIndex, 1);
                console.log("Product deleted due to zero stock:", { name: decodedName, brand: decodedBrand, material: decodedMaterial });
            }
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            return { product: products[productIndex] || null };
        });

        if (result.error) {
            return res.status(404).json({ message: result.error });
        }
        res.json(result.product || { message: "Product deleted due to zero stock" });
    } catch (err) {
        console.error("Error updating product:", err);
        res.status(400).json({ message: err.message || "Error updating product" });
    }
});

// Delete product
app.delete("/api/products/:name/:brand/:material", verifyToken, async (req, res) => {
    const { name, brand, material } = req.params;
    const decodedName = decodeURIComponent(name);
    const decodedBrand = decodeURIComponent(brand);
    const decodedMaterial = decodeURIComponent(material);
    console.log("Deleting product:", { name: decodedName, brand: decodedBrand, material: decodedMaterial });
    try {
        const result = await withFileLock(`delete_product_${decodedName}_${decodedBrand}_${decodedMaterial}`, async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            let products = JSON.parse(data);
            console.log("Products in file:", products);
            const productIndex = products.findIndex(p =>
                p.name === decodedName &&
                p.brand === decodedBrand &&
                p.material === decodedMaterial
            );
            if (productIndex === -1) {
                console.log("Product not found:", { name: decodedName, brand: decodedBrand, material: decodedMaterial });
                return { error: `Product not found: ${decodedName}, ${decodedBrand}, ${decodedMaterial}` };
            }
            const [deletedProduct] = products.splice(productIndex, 1);
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            return { product: deletedProduct };
        });

        if (result.error) {
            return res.status(404).json({ message: result.error });
        }
        res.json({ message: "Product deleted successfully" });
    } catch (err) {
        console.error("Error deleting product:", err);
        res.status(500).json({ message: "Error deleting product" });
    }
});

// Add to cart
app.post('/api/cart', async (req, res) => {
    try {
        const { guestId, name, brand, material, quantity } = req.body;
        console.log("Adding to cart:", { guestId, name, brand, material, quantity });

        if (!guestId || !name || !brand || !material || !quantity || quantity < 1) {
            return res.status(400).json({ message: 'Invalid guest ID, product details, or quantity' });
        }

        const products = JSON.parse(await fs.readFile(PRODUCTS_FILE, 'utf8'));
        const product = products.find(p => p.name === name && p.brand === brand && p.material === material);
        if (!product) {
            return res.status(404).json({ message: `Product not found: ${name}, ${brand}, ${material}` });
        }
        if (product.stock < quantity) {
            return res.status(400).json({ message: `Insufficient stock for ${name}` });
        }

        const result = await withFileLock('cart', async () => {
            let carts = [];
            try {
                carts = JSON.parse(await fs.readFile(CARTS_FILE, 'utf8'));
            } catch (err) { }

            let guestCart = carts.find(c => c.guestId === guestId);
            if (!guestCart) {
                guestCart = { guestId, items: [] };
                carts.push(guestCart);
            }

            const item = guestCart.items.find(i => i.name === name && i.brand === brand && i.material === material);
            if (item) {
                item.quantity += quantity;
            } else {
                guestCart.items.push({ name, brand, material, quantity });
            }

            await fs.writeFile(CARTS_FILE, JSON.stringify(carts, null, 2));
            return guestCart;
        });

        res.json({ message: 'Added to cart', cart: result });
    } catch (err) {
        console.error("Error updating cart:", err);
        res.status(500).json({ message: 'Error updating cart' });
    }
});

// Get cart
app.get('/api/cart', async (req, res) => {
    const { guestId } = req.query;
    console.log("Fetching cart for guestId:", guestId);
    try {
        if (!guestId) {
            return res.status(400).json({ message: 'Guest ID is required' });
        }
        const data = await fs.readFile(CARTS_FILE, 'utf8');
        const carts = JSON.parse(data);
        const guestCart = carts.find(c => c.guestId === guestId);
        res.json(guestCart || { guestId, items: [] });
    } catch (err) {
        console.error('Error reading carts:', err);
        res.status(500).json({ message: 'Error reading carts' });
    }
});

// Delete cart item
app.delete('/api/cart', async (req, res) => {
    const { guestId, name, brand, material } = req.body;
    console.log("Deleting cart item:", { guestId, name, brand, material });
    try {
        const result = await withFileLock('delete_cart_item', async () => {
            let carts = [];
            try {
                carts = JSON.parse(await fs.readFile(CARTS_FILE, 'utf8'));
            } catch (err) { }
            const guestCart = carts.find(c => c.guestId === guestId);
            if (!guestCart) {
                return { error: 'Cart not found' };
            }
            const itemIndex = guestCart.items.findIndex(i => i.name === name && i.brand === brand && i.material === material);
            if (itemIndex === -1) {
                return { error: 'Item not found in cart' };
            }
            guestCart.items.splice(itemIndex, 1);
            if (guestCart.items.length === 0) {
                carts = carts.filter(c => c.guestId !== guestId);
            }
            await fs.writeFile(CARTS_FILE, JSON.stringify(carts, null, 2));
            return { success: true };
        });
        if (result.error) {
            return res.status(404).json({ message: result.error });
        }
        res.json({ message: 'Item removed from cart' });
    } catch (err) {
        console.error('Error deleting cart item:', err);
        res.status(500).json({ message: 'Error deleting cart item' });
    }
});

// Create order
app.post('/api/orders', async (req, res) => {
    const { guestId, fullName, phone, address, paymentMethod, cardNumber, expiryDate, cvv, cartItems, totalPrice } = req.body;
    console.log("Received order:", { guestId, fullName, cartItems, totalPrice });

    try {
        if (!guestId || !fullName || !phone || !address || !paymentMethod || !cartItems?.length || !totalPrice) {
            console.log("Validation failed: Missing required fields");
            return res.status(400).json({ message: "Missing required fields" });
        }

        if (paymentMethod === 'card' && (!cardNumber || !expiryDate || !cvv)) {
            console.log("Validation failed: Missing card details");
            return res.status(400).json({ message: "Missing card details for card payment" });
        }

        if (isNaN(totalPrice) || totalPrice <= 0) {
            console.log("Validation failed: Invalid total price");
            return res.status(400).json({ message: "Invalid total price" });
        }

        const products = JSON.parse(await fs.readFile(PRODUCTS_FILE, 'utf8'));
        for (const item of cartItems) {
            if (!item.name || !item.brand || !item.material || !item.quantity || item.quantity < 1) {
                console.log("Validation failed: Invalid cart item", item);
                return res.status(400).json({ message: "Invalid cart item data" });
            }
            const product = products.find(p => p.name === item.name && p.brand === item.brand && p.material === item.material);
            if (!product) {
                console.log("Validation failed: Product not found", item);
                return res.status(404).json({ message: `Product not found: ${item.name}, ${item.brand}, ${item.material}` });
            }
            if (product.stock < item.quantity) {
                console.log("Validation failed: Insufficient stock", item);
                return res.status(400).json({ message: `Insufficient stock for ${item.name}` });
            }
        }

        const result = await withFileLock('create_order', async () => {
            let productsUpdated = JSON.parse(await fs.readFile(PRODUCTS_FILE, 'utf8'));
            for (const item of cartItems) {
                const productIndex = productsUpdated.findIndex(p => p.name === item.name && p.brand === item.brand && p.material === item.material);
                productsUpdated[productIndex].stock -= item.quantity;
                if (productsUpdated[productIndex].stock === 0) {
                    productsUpdated.splice(productIndex, 1);
                }
            }
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(productsUpdated, null, 2));

            let carts = [];
            try {
                carts = JSON.parse(await fs.readFile(CARTS_FILE, 'utf8'));
            } catch (err) { }
            carts = carts.filter(c => c.guestId !== guestId);
            await fs.writeFile(CARTS_FILE, JSON.stringify(carts, null, 2));

            let orders = [];
            try {
                orders = JSON.parse(await fs.readFile(ORDERS_FILE, 'utf8'));
            } catch (err) { }
            const newOrder = {
                guestId,
                fullName,
                phone,
                address,
                paymentMethod,
                cardDetails: paymentMethod === 'card' ? { cardNumber, expiryDate, cvv } : null,
                cartItems,
                totalPrice,
                orderDate: new Date().toISOString()
            };
            orders.push(newOrder);
            await fs.writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2));
            return newOrder;
        });

        console.log("Order created successfully:", result);
        res.status(201).json({ message: "Order created successfully", order: result });
    } catch (err) {
        console.error("Error creating order:", err);
        res.status(500).json({ message: "Error creating order" });
    }
});

// Start server
app.listen(PORT, async () => {
    try {
        await fs.mkdir(UPLOADS_DIR, { recursive: true });
        try {
            await fs.access(PRODUCTS_FILE);
        } catch {
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify([], null, 2));
            console.log("Initialized empty products.json");
        }
        try {
            await fs.access(CARTS_FILE);
        } catch {
            await fs.writeFile(CARTS_FILE, JSON.stringify([], null, 2));
            console.log("Initialized empty carts.json");
        }
        try {
            await fs.access(ORDERS_FILE);
        } catch {
            await fs.writeFile(ORDERS_FILE, JSON.stringify([], null, 2));
            console.log("Initialized empty orders.json");
        }
        console.log(`Server running on http://localhost:${PORT}`);
    } catch (err) {
        console.error("Error starting server:", err);
    }
});