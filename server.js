const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs").promises;
const path = require("path");
const lockfile = require("proper-lockfile");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTS_FILE = path.join(__dirname, "products.json");
const UPLOADS_DIR = path.join(__dirname, "Uploads");
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

// Helper function to compute image hash
async function getImageHash(fileBuffer) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash("sha256");
        hash.update(fileBuffer);
        resolve(hash.digest("hex"));
    });
}

// Helper function to check for existing image by hash
async function findExistingImage(fileBuffer) {
    const newHash = await getImageHash(fileBuffer);
    console.log("Computed image hash:", newHash);
    try {
        const files = await fs.readdir(UPLOADS_DIR);
        for (const filename of files) {
            const filePath = path.join(UPLOADS_DIR, filename);
            const existingBuffer = await fs.readFile(filePath);
            const existingHash = await getImageHash(existingBuffer);
            if (newHash === existingHash) {
                console.log("Found matching image:", filename);
                return `/backend/uploads/${filename}`;
            }
        }
    } catch (err) {
        console.error("Error scanning uploads directory:", err.message);
    }
    return null;
}

// Helper function to generate unique filename using timestamp
async function getUniqueFilename(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let newFilename = filename;

    // Check if file exists
    if (await fs.access(path.join(UPLOADS_DIR, newFilename)).then(() => true).catch(() => false)) {
        const timestamp = Date.now();
        newFilename = `${base}-${timestamp}${ext}`;
    }

    console.log("Generated filename:", newFilename);
    return newFilename;
}

// Multer storage configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOADS_DIR);
    },
    filename: async (req, file, cb) => {
        console.log("Processing file:", { originalname: file.originalname });
        const existingImageUrl = await findExistingImage(file.buffer);
        if (existingImageUrl) {
            console.log("Reusing existing image:", existingImageUrl);
            req.existingImageUrl = existingImageUrl;
            cb(null, path.basename(existingImageUrl));
        } else {
            const uniqueFilename = await getUniqueFilename(file.originalname);
            cb(null, uniqueFilename);
        }
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
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
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Custom middleware to make image upload optional
const optionalUpload = (req, res, next) => {
    upload.single("image")(req, res, (err) => {
        if (err instanceof multer.MulterError) {
            return res.status(400).json({ message: `Upload error: ${err.message}` });
        } else if (err) {
            return res.status(400).json({ message: err.message });
        }
        next();
    });
};

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
        if (!decoded.userId) {
            console.error("Token verification: Missing userId in token payload");
            return res.status(401).json({ message: "Invalid token: missing userId" });
        }
        req.user = decoded;
        console.log("Token verified, user:", req.user);
        next();
    } catch (err) {
        console.error("Token verification error:", err.message);
        return res.status(401).json({ message: "Invalid or expired token" });
    }
}

function generateProductCode(products, type, brand) {
    if (!type || !brand || typeof type !== "string" || typeof brand !== "string") {
        console.error("Invalid type or brand:", { type, brand });
        throw new Error("Type and brand must be non-empty strings");
    }
    const prefix = `${type.trim().charAt(0).toUpperCase()}${brand.trim().charAt(0).toUpperCase()}`.trim();
    const filteredNumbers = products
        .filter(p => p && p.id && typeof p.id === "string" && p.id.startsWith(prefix))
        .map(p => {
            const numberPart = p.id.replace(prefix, "").trim();
            const number = parseInt(numberPart, 10);
            return isNaN(number) || number < 0 ? null : number;
        })
        .filter(num => num !== null);
    const maxNumber = filteredNumbers.length > 0 ? Math.max(...filteredNumbers) : 0;
    const newNumber = maxNumber + 1;
    const newCode = `${prefix}${newNumber.toString().padStart(4, "0")}`;
    if (products.some(p => p?.id === newCode)) {
        console.warn("Duplicate ID detected, regenerating:", newCode);
        return generateProductCode(products, type, brand);
    }
    return newCode;
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
    const userId = username;
    const token = jwt.sign({ userId, username }, process.env.JWT_SECRET, { expiresIn: "1h" });
    console.log("Login successful:", { username, userId });
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
        const { name, brand, type, stock, originalPrice, salePrice, material } = req.body;
        console.log("Received FormData:", {
            name,
            brand,
            type,
            stock,
            originalPrice,
            salePrice,
            material,
            image: req.file ? req.file.filename : req.existingImageUrl || "No image"
        });

        if (!name || !brand || !type || !stock || !originalPrice || !salePrice || !material) {
            console.log("Validation failed: Missing required fields");
            return res.status(400).json({ message: "All fields are required, including material" });
        }

        const normalizedBrand = brand.trim();
        const normalizedType = type.trim();
        const normalizedMaterial = material.trim();

        if (!ALLOWED_BRANDS.includes(normalizedBrand)) {
            console.log("Validation failed: Invalid brand", normalizedBrand);
            return res.status(400).json({ message: `Invalid brand: "${brand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}` });
        }
        if (!ALLOWED_TYPES.includes(normalizedType)) {
            console.log("Validation failed: Invalid type", normalizedType);
            return res.status(400).json({ message: `Invalid type: "${type}". Must be one of: ${ALLOWED_TYPES.join(", ")}` });
        }
        if (!ALLOWED_MATERIALS.includes(normalizedMaterial)) {
            console.log("Validation failed: Invalid material", normalizedMaterial);
            return res.status(400).json({ message: `Invalid material: "${material}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}` });
        }

        const parsedStock = parseInt(stock);
        const parsedOriginalPrice = parseFloat(originalPrice);
        const parsedSalePrice = parseFloat(salePrice);

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
                if (!Array.isArray(products)) {
                    console.error("products.json is not an array:", data);
                    products = [];
                }
            } catch (err) {
                if (err.code === "ENOENT") {
                    console.log("products.json not found, creating empty file");
                    await fs.writeFile(PRODUCTS_FILE, JSON.stringify([], null, 2));
                } else {
                    console.error("Error reading products.json:", err);
                }
                products = [];
            }

            const imageUrl = req.existingImageUrl || (req.file ? `/backend/uploads/${req.file.filename}` : null);
            if (!imageUrl) {
                console.log("Validation failed: No valid image provided");
                return { error: "An image file (jpg or png) is required", status: 400 };
            }

            const newProduct = {
                id: generateProductCode(products, normalizedType, normalizedBrand),
                name,
                brand: normalizedBrand,
                type: normalizedType,
                stock: parsedStock,
                imageUrl,
                originalPrice: parsedOriginalPrice,
                salePrice: parsedSalePrice,
                material: normalizedMaterial,
                version: 0
            };
            products.push(newProduct);
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            console.log("Products after addition:", products.map(p => ({ id: p.id })));
            return newProduct;
        });

        if (newProduct.error) {
            if (req.file && !req.existingImageUrl) {
                await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(err => console.error("Failed to delete temp file:", err));
            }
            return res.status(newProduct.status || 400).json({ message: newProduct.error });
        }

        console.log("Product added:", newProduct);
        res.status(201).json(newProduct);
    } catch (err) {
        if (req.file && !req.existingImageUrl) {
            await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(err => console.error("Failed to delete temp file:", err));
        }
        console.error("Error adding product:", err);
        res.status(500).json({ message: err.message || "Error adding product" });
    }
});

// Update product
app.patch("/api/products/:id", verifyToken, optionalUpload, async (req, res) => {
    const { id } = req.params;
    const { name, brand, type, material, stock, originalPrice, salePrice, version, keepImage } = req.body || {};
    console.log("Updating product:", { id, name, brand, type, material, stock, originalPrice, salePrice, version, keepImage, file: req.file });

    try {
        const updates = {};
        if (name !== undefined) {
            const trimmedName = name.trim();
            if (!trimmedName) return res.status(400).json({ message: "Name cannot be empty" });
            updates.name = trimmedName;
        }
        if (brand !== undefined) {
            if (!ALLOWED_BRANDS.includes(brand)) return res.status(400).json({ message: `Invalid brand: "${brand}". Must be one of: ${ALLOWED_BRANDS.join(", ")}` });
            updates.brand = brand;
        }
        if (type !== undefined) {
            if (!ALLOWED_TYPES.includes(type)) return res.status(400).json({ message: `Invalid type: "${type}". Must be one of: ${ALLOWED_TYPES.join(", ")}` });
            updates.type = type;
        }
        if (material !== undefined) {
            const normalizedMaterial = material.trim();
            if (!ALLOWED_MATERIALS.includes(normalizedMaterial)) {
                return res.status(400).json({ message: `Invalid material: "${material}". Must be one of: ${ALLOWED_MATERIALS.join(", ")}` });
            }
            updates.material = normalizedMaterial;
        }
        if (stock !== undefined) {
            const parsedStock = parseInt(stock);
            if (isNaN(parsedStock) || parsedStock < 0) {
                return res.status(400).json({ message: "Invalid stock value" });
            }
            updates.stock = parsedStock;
        }
        if (originalPrice !== undefined) {
            const parsedOriginalPrice = parseFloat(originalPrice);
            if (isNaN(parsedOriginalPrice) || parsedOriginalPrice <= 0) {
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
        if (req.existingImageUrl) {
            updates.imageUrl = req.existingImageUrl;
        } else if (req.file) {
            updates.imageUrl = `/backend/uploads/${req.file.filename}`;
        } else if (keepImage !== "true") {
            return res.status(400).json({ message: "An image file is required unless keepImage is true" });
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" });
        }

        const result = await withFileLock(`update_product_${id}`, async () => {
            let products = [];
            try {
                const data = await fs.readFile(PRODUCTS_FILE, "utf8");
                products = JSON.parse(data);
                if (!Array.isArray(products)) {
                    console.error("products.json is not an array:", data);
                    await fs.writeFile(PRODUCTS_FILE, JSON.stringify([], null, 2));
                    return { error: "Invalid products data format", status: 500 };
                }
            } catch (err) {
                if (err.code === "ENOENT") {
                    console.log("products.json not found, creating empty file");
                    await fs.writeFile(PRODUCTS_FILE, JSON.stringify([], null, 2));
                } else {
                    console.error("Error reading products.json:", err);
                    return { error: "Error accessing product data", status: 500 };
                }
            }

            const productIndex = products.findIndex(p => p.id === id.trim());
            console.log("Product search:", { id, found: productIndex !== -1, products: products.map(p => ({ id: p.id })) });
            if (productIndex === -1) {
                return { error: `Product with ID ${id} not found`, status: 404 };
            }

            if (version !== undefined && parseInt(version) !== (products[productIndex].version || 0)) {
                return { error: "Product was modified by another user", status: 409 };
            }

            // Delete old image if a new one is provided
            if (updates.imageUrl && updates.imageUrl !== products[productIndex].imageUrl) {
                const oldImagePath = path.join(__dirname, products[productIndex].imageUrl || "");
                try {
                    await fs.unlink(oldImagePath);
                    console.log("Deleted old image:", oldImagePath);
                } catch (err) {
                    console.warn("Failed to delete old image:", err.message);
                }
            }

            updates.version = (products[productIndex].version || 0) + 1;
            products[productIndex] = { ...products[productIndex], ...updates };
            if (updates.stock === 0) {
                const deletedProduct = products.splice(productIndex, 1)[0];
                if (deletedProduct.imageUrl) {
                    const imagePath = path.join(__dirname, deletedProduct.imageUrl);
                    try {
                        await fs.unlink(imagePath);
                        console.log("Deleted image due to zero stock:", imagePath);
                    } catch (err) {
                        console.warn("Failed to delete image:", err.message);
                    }
                }
                console.log("Product deleted due to zero stock:", { id });
                return { deleted: true, message: "Product deleted due to zero stock" };
            }

            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            console.log("Products after update:", products.map(p => ({ id: p.id })));
            return { product: products[productIndex] };
        });

        if (result.error) {
            if (req.file && !req.existingImageUrl) {
                await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(err => console.error("Failed to delete temp file:", err));
            }
            return res.status(result.status || 404).json({ message: result.error });
        }

        res.json(result.product || { deleted: true, message: result.message });
    } catch (err) {
        if (req.file && !req.existingImageUrl) {
            await fs.unlink(path.join(UPLOADS_DIR, req.file.filename)).catch(err => console.error("Failed to delete temp file:", err));
        }
        console.error("Error updating product:", { id, error: err.message, stack: err.stack });
        res.status(500).json({ message: err.message || "Error updating product" });
    }
});

// DELETE endpoint
app.delete("/api/products/:id", verifyToken, async (req, res) => {
    const { id } = req.params;
    console.log("Received DELETE request for product:", { id, type: typeof id });

    try {
        const release = await lockfile.lock(PRODUCTS_FILE);
        try {
            let products = [];
            try {
                const data = await fs.readFile(PRODUCTS_FILE, "utf8");
                console.log("Raw products.json data:", data);
                products = JSON.parse(data);
                if (!Array.isArray(products)) {
                    console.error("products.json is not an array:", data);
                    await fs.writeFile(PRODUCTS_FILE, JSON.stringify([], null, 2));
                    return res.status(500).json({ message: "Invalid products data format. Reset to empty array." });
                }
            } catch (err) {
                if (err.code === "ENOENT") {
                    console.log("products.json not found, creating empty file");
                    await fs.writeFile(PRODUCTS_FILE, JSON.stringify([], null, 2));
                } else {
                    console.error("Error reading products.json:", err.message);
                    return res.status(500).json({ message: "Error accessing product data", error: err.message });
                }
            }

            if (!id || typeof id !== "string" || id.trim() === "") {
                console.warn("Invalid product ID:", id);
                return res.status(400).json({ message: "Invalid product ID" });
            }

            const productIndex = products.findIndex(p => p.id === id.trim());
            console.log("Product search:", { id, found: productIndex !== -1, products: products.map(p => ({ id: p.id })) });
            if (productIndex === -1) {
                return res.status(404).json({ message: `Product with ID ${id} not found` });
            }

            const deletedProduct = products.splice(productIndex, 1)[0];
            await fs.writeFile(PRODUCTS_FILE, JSON.stringify(products, null, 2));
            console.log("Products after deletion:", products.map(p => ({ id: p.id })));

            if (deletedProduct.imageUrl) {
                const imagePath = path.join(__dirname, deletedProduct.imageUrl);
                try {
                    await fs.unlink(imagePath);
                    console.log("Deleted image:", imagePath);
                } catch (err) {
                    console.warn("Failed to delete image:", err.message);
                }
            }

            res.json({ message: "Product deleted successfully" });
        } finally {
            await release();
        }
    } catch (err) {
        console.error("Error deleting product:", { id, error: err.message, stack: err.stack });
        res.status(500).json({ message: "Error deleting product", error: err.message });
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