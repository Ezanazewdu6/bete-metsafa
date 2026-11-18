/**
 * Bete Metsahaf - Seed Books and Categories
 * Populates the library with a curated selection of books across multiple departments.
 */

require('dotenv').config();
const db = require('./db');

const categories = [
  'Computer Science & IT',
  'Software Engineering',
  'Ethiopian Literature & History',
  'Mathematics & Natural Sciences',
  'Electrical & Mechanical Engineering'
];

const books = [
  {
    isbn: '9780132350884',
    title: 'Clean Code: A Handbook of Agile Software Craftsmanship',
    author: 'Robert C. Martin',
    publisher: 'Prentice Hall',
    pub_year: 2008,
    category: 'Software Engineering',
    shelf: 'CS-01',
    total_copies: 5,
    description: 'Best practices for writing clean, readable, and maintainable software.'
  },
  {
    isbn: '9780262033848',
    title: 'Introduction to Algorithms (CLRS)',
    author: 'Thomas H. Cormen, Charles E. Leiserson, Ronald L. Rivest, Clifford Stein',
    publisher: 'MIT Press',
    pub_year: 2009,
    category: 'Computer Science & IT',
    shelf: 'CS-02',
    total_copies: 4,
    description: 'The definitive textbook covering algorithms and data structures in depth.'
  },
  {
    isbn: '9780135957059',
    title: 'The Pragmatic Programmer: Your Journey to Mastery',
    author: 'David Thomas, Andrew Hunt',
    publisher: 'Addison-Wesley',
    pub_year: 2019,
    category: 'Software Engineering',
    shelf: 'CS-01',
    total_copies: 3,
    description: 'Timeless practical advice and career wisdom for software developers.'
  },
  {
    isbn: '9780262035613',
    title: 'Deep Learning',
    author: 'Ian Goodfellow, Yoshua Bengio, Aaron Courville',
    publisher: 'MIT Press',
    pub_year: 2016,
    category: 'Computer Science & IT',
    shelf: 'CS-03',
    total_copies: 3,
    description: 'Comprehensive introduction to neural networks, backpropagation, and deep learning.'
  },
  {
    isbn: '9780133594140',
    title: 'Computer Networking: A Top-Down Approach',
    author: 'James F. Kurose, Keith W. Ross',
    publisher: 'Pearson',
    pub_year: 2017,
    category: 'Computer Science & IT',
    shelf: 'CS-03',
    total_copies: 4,
    description: 'Classic top-down approach to Internet protocols, layers, and network architecture.'
  },
  {
    isbn: '9781118063330',
    title: 'Operating System Concepts (Dinosaur Book)',
    author: 'Abraham Silberschatz, Peter B. Galvin, Greg Gagne',
    publisher: 'Wiley',
    pub_year: 2018,
    category: 'Computer Science & IT',
    shelf: 'CS-02',
    total_copies: 4,
    description: 'Fundamental principles of processes, threads, virtual memory, and file systems.'
  },
  {
    isbn: '9789994499106',
    title: 'Oromay (ኦሮማይ)',
    author: 'Baalu Girma (በዓሉ ግርማ)',
    publisher: 'Kuraz Publishing',
    pub_year: 1983,
    category: 'Ethiopian Literature & History',
    shelf: 'LIT-01',
    total_copies: 6,
    description: 'Historic Ethiopian political and social novel set during Operation Red Star in Asmara.'
  },
  {
    isbn: '9789994499212',
    title: 'Fikir Eske Mekabir (ፍቅር እስከ መቃብር)',
    author: 'Haddis Alemayehu (ሀዲስ አለማየሁ)',
    publisher: 'Berhanena Selam',
    pub_year: 1968,
    category: 'Ethiopian Literature & History',
    shelf: 'LIT-01',
    total_copies: 8,
    description: 'Masterpiece of modern Amharic literature exploring love, class, and feudal society.'
  },
  {
    isbn: '9780821414408',
    title: 'A History of Modern Ethiopia, 1855–1991',
    author: 'Bahru Zewde',
    publisher: 'Ohio University Press',
    pub_year: 2002,
    category: 'Ethiopian Literature & History',
    shelf: 'HIST-01',
    total_copies: 4,
    description: 'Standard academic text on modern Ethiopian political, social, and economic history.'
  },
  {
    isbn: '9781285741550',
    title: 'Calculus: Early Transcendentals',
    author: 'James Stewart',
    publisher: 'Cengage Learning',
    pub_year: 2015,
    category: 'Mathematics & Natural Sciences',
    shelf: 'MATH-01',
    total_copies: 5,
    description: 'Standard university calculus covering limits, derivatives, integration, and series.'
  },
  {
    isbn: '9780078028229',
    title: 'Fundamentals of Electric Circuits',
    author: 'Charles K. Alexander, Matthew N. O. Sadiku',
    publisher: 'McGraw-Hill',
    pub_year: 2016,
    category: 'Electrical & Mechanical Engineering',
    shelf: 'ENG-01',
    total_copies: 4,
    description: 'Circuit analysis, Ohm/Kirchhoff laws, nodal and mesh analysis, and AC circuits.'
  },
  {
    isbn: '9780134444406',
    title: 'Digital Design: With an Introduction to the Verilog HDL',
    author: 'M. Morris Mano, Michael D. Ciletti',
    publisher: 'Pearson',
    pub_year: 2018,
    category: 'Electrical & Mechanical Engineering',
    shelf: 'ENG-02',
    total_copies: 4,
    description: 'Boolean algebra, logic gates, combinational logic, and sequential circuits.'
  }
];

async function seed() {
  console.log('Seeding categories and books into library database...\n');

  try {
    const categoryMap = {};
    for (const catName of categories) {
      const [existing] = await db.query('SELECT id FROM categories WHERE name = ?', [catName]);
      if (existing.length > 0) {
        categoryMap[catName] = existing[0].id;
      } else {
        const [res] = await db.query('INSERT INTO categories (name) VALUES (?)', [catName]);
        categoryMap[catName] = res.insertId;
        console.log(`  + Category: "${catName}" (ID ${categoryMap[catName]})`);
      }
    }

    let addedCount = 0;
    for (const b of books) {
      const catId = categoryMap[b.category] || null;
      const [existing] = await db.query('SELECT id FROM books WHERE isbn = ?', [b.isbn]);
      if (existing.length === 0) {
        await db.query(
          `INSERT INTO books (isbn, title, author, publisher, pub_year, category_id, shelf, total_copies, available_copies, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            b.isbn,
            b.title,
            b.author,
            b.publisher,
            b.pub_year,
            catId,
            b.shelf,
            b.total_copies,
            b.total_copies,
            b.description
          ]
        );
        addedCount++;
        console.log(`  + Book: "${b.title}" [${b.total_copies} copies, Shelf ${b.shelf}]`);
      }
    }

    const [[stats]] = await db.query(
      'SELECT COUNT(*) as titles, COALESCE(SUM(total_copies), 0) as copies FROM books'
    );
    console.log(`\nSuccess! The library now has:`);
    console.log(`  - Total Titles (unique books): ${stats.titles}`);
    console.log(`  - Total Physical Copies: ${stats.copies}`);
  } catch (err) {
    console.error('Seeding error:', err);
  } finally {
    await db.end();
  }
}

seed();
