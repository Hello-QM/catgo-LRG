# Visualizing and Testing the VASP Backend

## Quick Start

### 1. Start the Server

```bash
cd server
conda activate catgo-server  # or your environment name
python main.py
```

You should see:

```
INFO:     Uvicorn running on http://127.0.0.1:8000
```

### 2. Interactive API Documentation (Best Option!)

**Open in your browser:**

- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

This gives you:

- ✅ Visual interface to test all endpoints
- ✅ See request/response schemas
- ✅ Try VASP generation directly
- ✅ No coding needed!

### 3. Test VASP Endpoints

#### Option A: Using the Browser (Swagger UI)

1. Go to http://localhost:8000/docs
2. Find `/api/vasp/generate` endpoint
3. Click "Try it out"
4. Fill in the structure data (or use the example)
5. Click "Execute"
6. See the generated INCAR, POSCAR, KPOINTS files!

#### Option B: Using curl

```bash
# List calculation types
curl http://localhost:8000/api/vasp/calculation-types

# Generate VASP inputs
curl -X POST "http://localhost:8000/api/vasp/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "structure": {
      "lattice": {
        "matrix": [[4.0, 0.0, 0.0], [0.0, 4.0, 0.0], [0.0, 0.0, 4.0]],
        "a": 4.0, "b": 4.0, "c": 4.0,
        "alpha": 90.0, "beta": 90.0, "gamma": 90.0,
        "volume": 64.0, "pbc": [true, true, true]
      },
      "sites": [
        {
          "species": [{"element": "Si", "occu": 1.0}],
          "abc": [0.0, 0.0, 0.0],
          "xyz": [0.0, 0.0, 0.0]
        }
      ]
    },
    "calculation_type": "scf",
    "encut": 520.0
  }'
```

#### Option C: Using Python Test Script

```bash
# Install requests if needed
pip install requests

# Run the test script
python test_vasp.py
```

### 4. Available Endpoints

- `GET /` - API information
- `GET /health` - Health check
- `GET /api/vasp/calculation-types` - List all calculation types
- `POST /api/vasp/generate` - Generate VASP input files

### 5. Example Response

When you call `/api/vasp/generate`, you get:

```json
{
  "incar": "ENCUT = 520.0\nEDIFF = 1e-06\n...",
  "poscar": "Si\n1.0\n4.0 0.0 0.0\n...",
  "kpoints": "Automatic mesh\n0\nMonkhorst\n3 3 3\n...",
  "potcar_info": {
    "elements": ["Si"],
    "note": "POTCAR file must be generated separately..."
  },
  "calculation_type": "scf",
  "notes": "VASP input files for SCF calculation..."
}
```

### 6. Integration with Frontend

The frontend can call these endpoints using:

- `fetch()` API
- Or any HTTP client library

Example frontend code:

```javascript
const response = await fetch('http://localhost:8000/api/vasp/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    structure: structureData,
    calculation_type: 'opt',
    encut: 520.0,
  }),
})

const vaspFiles = await response.json()
console.log(vaspFiles.incar) // INCAR content
console.log(vaspFiles.poscar) // POSCAR content
console.log(vaspFiles.kpoints) // KPOINTS content
```

## Troubleshooting

**Server won't start:**

- Check if port 8000 is in use
- Make sure all dependencies are installed: `pip install -r requirements.txt`

**Cannot connect:**

- Make sure server is running
- Check firewall settings
- Try `http://127.0.0.1:8000` instead of `localhost`

**Import errors:**

- Make sure you're in the conda environment: `conda activate catgo-server`
- Verify packages: `python -c "import fastapi, pymatgen; print('OK')"`
