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

// File lock wrapper
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
        res.json(products);
    } catch (err) {
        console.error("Error reading products:", err);
        res.status(500).json({ message: "Error reading products" });
    }
});

// Upload Excel file
app.post('/api/upload-excel', verifyToken, upload.single('excel'), async (req, res) => {
    try {
        if (!req.file) {
            console.log("Validation failed: No Excel file provided");
            return res.status(400).json({ message: 'No Excel file provided' });
        }

        // Read the uploaded Excel file
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(req.file.buffer);
        const worksheet = workbook.getWorksheet(1);
        const data = [];

        // Parse rows into JSON
        worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (rowNumber === 1) return; // Skip header
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

        // Validate data
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

        // Save to products.json
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

            // Check for duplicates
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
        console.log("Received FormData:", {
            name,
            brand,
            type,
            stock,
            originalPrice,
            salePrice,
            material,
            image: req.file ? req.file.filename : "No image"
        });

        // Validate required fields
        if (!name || !brand || !type || !stock || !originalPrice || !salePrice || !material || !req.file) {
            console.log("Validation failed: Missing required fields");
            return res.status(400).json({ message: "All fields are required, including a jpg or png image file and material" });
        }

        // Validate brand, type, and material
        const normalizedBrand = brand.trim();
        const normalizedType = type.trim();
        const normalizedMaterial = material.trim();

        if (!ALLOWED_BRANDS.includes(normalizedBrand)) {
            console.log("Validation failed: Invalid brand", normalizedBrand);
            return res.status(400).json({
                message: `Invalid brand: "${brand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}`
            });
        }
        if (!ALLOWED_TYPES.includes(normalizedType)) {
            console.log("Validation failed: Invalid type", normalizedType);
            return res.status(400).json({
                message: `Invalid type: "${type}". Must be one of: ${ALLOWED_TYPES.join(", ")}`
            });
        }
        if (!ALLOWED_MATERIALS.includes(normalizedMaterial)) {
            console.log("Validation failed: Invalid material", normalizedMaterial);
            return res.status(400).json({
                message: `Invalid material: "${material}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}`
            });
        }

        const parsedStock = parseInt(stock);
        const parsedOriginalPrice = parseFloat(originalPrice);
        const parsedSalePrice = parseFloat(salePrice);

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

            // Check for duplicate product
            if (products.some(p => p.name === name && p.brand === normalizedBrand && p.material === normalizedMaterial)) {
                throw new Error(`Product already exists: ${name}, ${normalizedBrand}, ${normalizedMaterial}`);
            }

            const newProduct = {
                name,
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
        res.status(500).json({ message: err.message || "Error adding product" });
    }
});

// Update product
app.patch("/api/products/:name/:brand/:material", verifyToken, async (req, res) => {
    const { name, brand, material } = req.params;
    const { stock, originalPrice, salePrice, newMaterial } = req.body;
    console.log("Updating product:", { name, brand, material, stock, originalPrice, salePrice, newMaterial });

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
                    message: `Invalid material: "${newMaterial}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}`
                });
            }
            updates.material = normalizedMaterial;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" });
        }

        const result = await withFileLock(`update_product_${name}_${brand}_${material}`, async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            const products = JSON.parse(data);
            const productIndex = products.findIndex(p => p.name === name && p.brand === brand && p.material === material);
            if (productIndex === -1) {
                return { error: "Product not found" };
            }
            products[productIndex] = { ...products[productIndex], ...updates };
            if (updates.stock === 0) {
                products.splice(productIndex, 1);
                console.log("Product deleted due to zero stock:", { name, brand, material });
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
        res.status(500).json({ message: "Error updating product" });
    }
});

// Delete product
app.delete("/api/products/:name/:brand/:material", verifyToken, async (req, res) => {
    const { name, brand, material } = req.params;
    console.log("Deleting product:", { name, brand, material });
    try {
        const result = await withFileLock(`delete_product_${name}_${brand}_${material}`, async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            const products = JSON.parse(data);
            const productIndex = products.findIndex(p => p.name === name && p.brand === brand && p.material === material);
            if (productIndex === -1) {
                return { error: "Product not found" };
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
app.post('/api/cart', verifyToken, async (req, res) => {
    try {
        const { name, brand, material, quantity } = req.body;
        const userId = req.user.username; // Using username from JWT
        console.log("Adding to cart:", { name, brand, material, quantity, userId });

        if (!name || !brand || !material || !quantity || quantity < 1) {
            return res.status(400).json({ message: 'Invalid product details or quantity' });
        }

        // Check product and stock
        const products = JSON.parse(await fs.readFile(PRODUCTS_FILE, 'utf8'));
        const product = products.find(p => p.name === name && p.brand === brand && p.material === material);
        if (!product) {
            return res.status(404).json({ message: 'Product not found' });
        }
        if (product.stock < quantity) {
            return res.status(400).json({ message: 'Insufficient stock' });
        }

        // Update cart
        const result = await withFileLock('cart', async () => {
            let carts = [];
            try {
                carts = JSON.parse(await fs.readFile(CARTS_FILE, 'utf8'));
            } catch (err) { }

            let userCart = carts.find(c => c.userId === userId);
            if (!userCart) {
                userCart = { userId, items: [] };
                carts.push(userCart);
            }

            const item = userCart.items.find(i => i.name === name && i.brand === brand && i.material === material);
            if (item) {
                item.quantity += quantity;
            } else {
                userCart.items.push({ name, brand, material, quantity });
            }

            await fs.writeFile(CARTS_FILE, JSON.stringify(carts, null, 2));
            return userCart;
        });

        res.json({ message: 'Added to cart', cart: result });
    } catch (err) {
        console.error("Error updating cart:", err);
        res.status(500).json({ message: 'Error updating cart' });
    }
});

// Get all carts
app.get('/api/cart', verifyToken, async (req, res) => {
    try {
        const data = await fs.readFile(CARTS_FILE, 'utf8');
        const carts = JSON.parse(data);
        const userCart = carts.find(c => c.userId === req.user.username);
        res.json(userCart || { userId: req.user.username, items: [] });
    } catch (err) {
        console.error('Error reading carts:', err);
        res.status(500).json({ message: 'Error reading carts' });
    }
});

// Delete cart item
app.delete('/api/cart', verifyToken, async (req, res) => {
    const { name, brand, material } = req.body;
    const userId = req.user.username;
    console.log("Deleting cart item:", { name, brand, material, userId });
    try {
        const result = await withFileLock('delete_cart_item', async () => {
            let carts = [];
            try {
                carts = JSON.parse(await fs.readFile(CARTS_FILE, 'utf8'));
            } catch (err) { }
            const userCart = carts.find(c => c.userId === userId);
            if (!userCart) {
                return { error: 'Cart not found' };
            }
            const itemIndex = userCart.items.findIndex(i => i.name === name && i.brand === brand && i.material === material);
            if (itemIndex === -1) {
                return { error: 'Item not found in cart' };
            }
            userCart.items.splice(itemIndex, 1);
            if (userCart.items.length === 0) {
                carts = carts.filter(c => c.userId !== userId);
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
        console.log(`Server running on http://localhost:${PORT}`);
    } catch (err) {
        console.error("Error starting server:", err);
    }
});