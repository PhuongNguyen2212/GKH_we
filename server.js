const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");
const lockfile = require("proper-lockfile");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTS_FILE = path.join(__dirname, "products.json");
const UPLOADS_DIR = path.join(__dirname, "Uploads");
const ALLOWED_BRANDS = ["Cartier", "Bvlgari", "Van Cleef & Arpels", "Chrome Hearts", "GKH Jewelry"];

// Middleware
app.use(cors());
app.use(express.json());
app.use("/backend/Uploads", express.static(UPLOADS_DIR, {
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

// File lock wrapper
async function withFileLock(operation, callback) {
    console.log(`Starting operation: ${operation}`);
    const release = await lockfile.lock(PRODUCTS_FILE, { retries: 10 });
    try {
        return await callback();
    } finally {
        await release();
        console.log(`Completed operation: ${operation}`);
    }
}

// JWT verification middleware
function verifyToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
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

// Add a new product
app.post("/api/products", verifyToken, upload.single("image"), async (req, res) => {
    try {
        const { name, brand, stock, originalPrice, salePrice } = req.body;
        console.log("Received FormData:", { name, brand, stock, originalPrice, salePrice, image: req.file?.filename });
        if (!name || !brand || !stock || !originalPrice || !salePrice || !req.file) {
            return res.status(400).json({ message: "All fields are required, including a jpg or png image file" });
        }
        const normalizedBrand = brand.trim();
        if (!ALLOWED_BRANDS.includes(normalizedBrand)) {
            return res.status(400).json({
                message: `Invalid brand: "${brand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}`
            });
        }
        const parsedStock = parseInt(stock);
        const parsedOriginalPrice = parseFloat(originalPrice);
        const parsedSalePrice = parseFloat(salePrice);
        if (
            isNaN(parsedStock) || parsedStock < 0 ||
            isNaN(parsedOriginalPrice) || parsedOriginalPrice < 0 ||
            isNaN(parsedSalePrice) || parsedSalePrice < 0
        ) {
            return res.status(400).json({ message: "Invalid numeric fields" });
        }

        const newProduct = await withFileLock("add_product", async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            const products = JSON.parse(data);
            const newProduct = {
                id: products.length ? Math.max(...products.map((p) => p.id)) + 1 : 1,
                name,
                brand: normalizedBrand,
                stock: parsedStock,
                imageUrl: `/backend/Uploads/${req.file.filename}`,
                originalPrice: parsedOriginalPrice,
                salePrice: parsedSalePrice,
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
app.patch("/api/products/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    const { stock, originalPrice, salePrice } = req.body;
    console.log("Updating product:", { id, stock, originalPrice, salePrice });

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

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" });
        }

        const result = await withFileLock(`update_product_${id}`, async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            const products = JSON.parse(data);
            const productIndex = products.findIndex((p) => p.id === parseInt(id));
            if (productIndex === -1) {
                return { error: "Product not found" };
            }
            products[productIndex] = { ...products[productIndex], ...updates };
            if (updates.stock === 0) {
                products.splice(productIndex, 1);
                console.log("Product deleted due to zero stock:", { id });
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
app.delete("/api/products/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    console.log("Deleting product:", { id });
    try {
        const result = await withFileLock(`delete_product_${id}`, async () => {
            const data = await fs.readFile(PRODUCTS_FILE, "utf8");
            const products = JSON.parse(data);
            const productIndex = products.findIndex((p) => p.id === parseInt(id));
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
        console.log(`Server running on http://localhost:${PORT}`);
    } catch (err) {
        console.error("Error starting server:", err);
    }
});