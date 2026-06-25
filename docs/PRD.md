# Blogzilla V1 - Product Requirements Document (PRD)

## 1. Functional Requirements

### 1.1 Authentication & Authorization
* **User Registration**
  * Register using email and password
  * Validate email format and password strength
  * Email verification
* **Login & Sessions**
  * Login using email and password
  * JWT Access Token with Refresh Token mechanism
  * Logout current device / Logout all devices
* **Password Management**
  * Forgot password / Reset password
  * Change password
* **Account Management**
  * Account deletion (Soft delete or permanent deletion with confirmation)
  * Data export (User can request their data)
* **Authorization**
  * Roles: User, Admin
  * Route protection and resource ownership checks

### 1.2 User Profile
* **Profile Management**
  * View and edit profile (Name, Username, Bio, Avatar, Social links, Website)
* **Public Profile View**
  * Shows: Name, Username, Bio, Followers/Following count, Published Blogs, Total Likes Received

### 1.3 Blog Management
* **Create & Edit Blog**
  * Fields: Title, Subtitle, Rich content, Cover image, Tags, Categories
  * Edit any draft or published blog
* **Deletion**
  * Soft delete implementation for blogs
* **Drafts & Publishing**
  * Autosave drafts, manual save, and recover drafts
  * Publish immediately or unpublish
  * Statuses: Draft, Published, Archived, Deleted

### 1.4 Rich Text Editor
* **Features**
  * Headings, Paragraphs, Lists, Tables, Blockquotes, Links, Images, Code Blocks
  * Markdown shortcuts and Syntax highlighting
* **Implementation Strategy**
  * Use **Tiptap** for the editor.
  * Strict content sanitization strategy to prevent XSS attacks.

### 1.5 Blog Discovery & SEO
* **Home Feed**
  * Latest blogs, Trending blogs, Recommended blogs
  * Cursor-based pagination
* **Following Feed**
  * Shows blogs from followed authors.
  * **Architecture:** Initially use **Fan-Out on Read**. Designed to evolve into **Fan-Out on Write** if scaling demands it.
  * Cursor-based pagination
* **Explore Page**
  * Discover Authors, Categories, Tags
* **SEO & Metadata**
  * Auto-generated slugs
  * Meta tags, Open Graph tags, canonical URLs
  * Sitemap and robots.txt generation
* **RSS Feed**
  * RSS feed support for individual authors and categories

### 1.6 Search
* **Entities:** Blogs, Users, Tags
* **Search By:** Title, Content, Tags, Categories, Name, Username

### 1.7 Interaction & Engagement
* **Comments**
  * Add, edit, delete comments
  * Nested comments / Replies
  * Cursor-based pagination
* **Likes**
  * Like/Unlike blogs (Prevent duplicate likes)
  * *Note: Ratings system has been removed in favor of simpler Likes.*
* **Bookmarks**
  * Bookmark/Remove bookmark for blogs
  * View bookmarks list with cursor-based pagination
* **Follow System**
  * Follow/Unfollow authors
  * Track followers and following counts

### 1.8 Notifications
* **In-App Notifications**
  * Events: New follower, Blog liked, Comment received, Blog published
  * Cursor-based pagination
* **Email Notifications**
  * Events: Verification email, Password reset, New follower, Blog interactions

### 1.9 Analytics Dashboard
* **Author Dashboard Metrics**
  * Blog Metrics: Total Blogs, Published Blogs, Drafts
  * Engagement: Likes, Comments
  * Audience: Followers Growth
  * Reading Metrics: Total Reads, Avg Read Time
* **Implementation Strategy**
  * Backed by PostgreSQL with Redis + BullMQ for buffered updates (instead of a dedicated time-series DB).

### 1.10 Media Management
* **Uploads:** Profile Images, Blog Cover Images, Embedded Images
* **Storage Abstraction:**
  * Implement `IStorageProvider` interface to decouple storage logic.
  * Initial provider: Cloudinary

### 1.11 Reading Experience
* **Features:** Estimated read time, Table of contents, Syntax highlighting, Responsive content layout.

### 1.12 Admin Features
* **Capabilities:** Ban users, Delete blogs, Manage categories, Review reports, View platform analytics.
* **Category Management:** Admin-controlled predefined categories (e.g., Technology, Programming, AI, Web Development).
* **Reporting System:** Users can report content for Spam, Abuse, Copyright. Admins review reports.

### 1.13 Tag System
* Blogs can have multiple tags (e.g., React, NodeJS, PostgreSQL).

### 1.14 Event System
* **Domain Events:** `USER_REGISTERED`, `USER_FOLLOWED`, `BLOG_CREATED`, `BLOG_PUBLISHED`, `BLOG_UPDATED`, `BLOG_LIKED`, `COMMENT_CREATED`, `NOTIFICATION_CREATED`.
* Used for triggering Notifications, Analytics buffering, and Emails.

---

## 2. Non-Functional Requirements

### 2.1 Architecture & Database
* **Pattern:** Modular Monolith with feature-first structure (Service Layer, Repository Pattern, DTO Pattern). Event-driven communication for decoupled domains.
* **Database:** **PostgreSQL** with **Prisma ORM**.
* **Caching:** **Redis** for read-heavy endpoints and session management.
* **Background Jobs:** **Redis + BullMQ** for processing background tasks (emails, notifications, analytics buffering, media processing).

### 2.2 Performance & Scalability
* Use **cursor-based pagination** for all infinite-scroll feeds (Feeds, Comments, Notifications, Bookmarks).
* Database indexing and query optimization.
* Caching layers for expensive operations.

### 2.3 Security
* JWT Authentication and Refresh Tokens
* Password Hashing (bcrypt/argon2)
* Strict input validation
* Tiptap-based XSS Protection & HTML sanitization
* Rate limiting and spam prevention mechanisms
* CSRF Protection, Helmet headers

### 2.4 Reliability & Observability
* Structured Logging, Request Tracking, Error Monitoring
* Error handling with specific AppError classes
* Retry mechanisms for external services (e.g., Cloudinary, Email provider)

### 2.5 Developer Experience
* **Stack:** TypeScript, ESLint, Prettier, Husky, Commitlint
* API Documentation (Swagger/OpenAPI)

### 2.6 UX / Accessibility
* Keyboard Navigation, Screen Readers, ARIA Labels
* Fully Responsive Design (Mobile, Tablet, Desktop)

---

## 3. Deferred Features (Post V1)
*The following features have been explicitly deferred until after the core V1 platform is stable:*
* AI Features (Blog summarization, Tag suggestions, SEO suggestions, AI-generated cover images)
* Advanced Analytics (Retention analytics, Heatmaps, Reader behavior analytics)
* Schedule publish (future dates)
* Push / SMS Notifications
* Premium Membership / Newsletter System
