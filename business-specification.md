# TIMMERS GADGET

## Approved Product Specification v1.3

**Status:** APPROVED baseline for MVP development
**Product Owner:** Final authority on all major product and business decisions
**Business:** TIMMERS GADGET
**Currency:** Nigerian Naira (NGN / ₦)
**Initial deployment:** One physical location
**Initial workforce:** 2–5 employees
**Application type:** Responsive Progressive Web App (PWA)

---

# 1. PRODUCT PURPOSE

TIMMERS GADGET requires an internal business-management and record-keeping system for a gadget retail shop.

The system will replace manual and disconnected record keeping with a centralized application for managing:

* Products
* Inventory
* Serialized products
* Purchases
* Suppliers
* Sales
* Point of Sale
* Customers
* Payments
* Discounts
* Returns
* Credit transactions
* Expenses
* Manufacturer warranties
* Reports
* Staff access
* Approval workflows
* Audit history

The system must provide a reliable operational record of:

* What products the business owns
* What products have been sold
* What products have been returned
* How much inventory is available
* What the business paid for inventory
* How much revenue has been generated
* Gross profit
* Business expenses
* Customer credit balances
* Supplier outstanding balances
* Who performed or approved sensitive actions

The application must operate effectively on:

* Laptop
* Desktop
* Mobile phone
* Tablet where naturally supported

---

# 2. BUSINESS SCOPE

TIMMERS GADGET sells:

* Phones
* Laptops
* Tablets
* Earphones
* Smartwatches
* Gaming equipment
* Gaming consoles
* Smart glasses
* Smart TVs
* General computers

The system must allow additional product categories to be created without requiring application restructuring.

---

# 3. PRODUCT CONDITIONS

The business sells:

* NEW
* USED
* REFURBISHED

Product condition must be recorded appropriately.

For serialized products, the condition applies to the individual unit and must remain part of that unit's historical record.

---

# 4. BUSINESS LOCATION

The MVP supports:

**One physical shop location.**

Multi-branch functionality is OUT OF SCOPE for MVP.

The architecture should not unnecessarily prevent future multi-location support.

---

# 5. INITIAL DATA

Existing shop records will not be imported into the new system.

The application starts fresh.

All products and starting inventory will be entered into the new system.

Historical data migration is not required for MVP.

---

# 6. CURRENCY

The system operates in:

**Nigerian Naira (NGN / ₦).**

Authoritative monetary values must use fixed-precision decimal/numeric storage and calculations.

JavaScript floating-point arithmetic must not be used as the authoritative representation of business money.

---

# 7. APPLICATION PLATFORM

The application will be a:

**Responsive Progressive Web App (PWA).**

A single codebase will support:

* Laptop
* Desktop
* Mobile
* Tablet where applicable

Native Android and native iOS applications are not part of the MVP.

The application should be installable on supported devices where practical.

---

# 8. USER ROLES

Initial operational roles are:

1. ADMIN
2. MANAGER
3. STAFF

Permissions must be enforced:

* In the user interface
* On the server
* At the database level where appropriate

UI restrictions alone are not sufficient authorization.

---

# 9. ADMIN

Admin represents owner-level authority.

Admin can:

* Manage products
* Manage product categories and brands
* Manage inventory
* Perform inventory adjustments
* Manage suppliers
* Manage customers
* Create/manage purchases
* Manage sales
* Reverse completed sales
* Approve/reject returns
* Determine returned-product classification
* Approve/reject discounts
* Configure Manager discount limits
* Approve/manage credit
* Manage expenses
* View complete financial reports
* Manage Staff and Manager accounts
* Configure approved business settings
* View audit logs
* Export permitted business data

Important Admin actions must remain auditable.

Admin authority does not permit silent rewriting or deletion of historical transaction records.

---

# 10. MANAGER

Manager handles approved day-to-day business-management functions.

Manager may:

* Create products
* Edit current product information
* Set/change current selling prices
* View acquisition costs where operationally required
* Create purchases
* Manage suppliers
* Perform inventory adjustments with mandatory reason
* Create sales
* Manage customers
* Record expenses
* Approve customer credit
* View operational and financial reports
* Approve Staff discount requests within the configured Manager limit
* Record customer credit repayments
* Perform ordinary operational functions

Manager cannot:

* Change own role
* Change own permissions
* Change another user's security role without explicit Admin authority
* Create an Admin
* Change the Manager discount limit
* Approve discounts beyond the configured Manager limit
* Approve customer returns
* Modify historical acquisition costs
* Delete audit history
* Reverse completed sales
* Circumvent security controls
* Change protected Admin-only system settings

---

# 11. STAFF

Staff handles routine shop operations.

Staff may:

* Search products
* View permitted inventory information
* Create sales
* Create customers
* Record and confirm permitted payments
* Request discounts
* Submit return requests
* Request credit-sale approval
* Record approved credit repayments
* Use camera scanning for approved operational purposes
* View their own permitted transaction/activity information

Staff cannot:

* Approve discounts
* Approve returns
* Independently approve credit sales
* Arbitrarily adjust inventory
* Change acquisition costs
* Change protected selling prices
* Reverse completed sales
* Record business expenses
* Manage Staff accounts
* Manage roles or permissions
* Change business settings
* View unrestricted financial reports
* Modify audit history
* Perform administrative operations

---

# 12. STAFF COMMISSION

TIMMERS GADGET does not currently operate a Staff commission system.

Staff commission functionality is:

**OUT OF SCOPE FOR MVP.**

Staff performance reports must not automatically imply commission calculations.

---

# 13. PRODUCT MANAGEMENT

Products must have structured records.

Relevant information includes:

* Product name
* Brand/manufacturer
* Category
* Model
* Description
* SKU
* Barcode where applicable
* Selling price
* Acquisition/cost information
* Stock information
* Minimum stock level
* Condition
* Serialized/non-serialized tracking
* Manufacturer warranty information

The system should support product variants where useful.

Examples:

* Colour
* Storage
* Capacity
* Model variation
* Condition

---

# 14. SERIALIZED PRODUCTS

Products such as phones, laptops, tablets, consoles and similar high-value products may require individual tracking.

The system must support:

* IMEI 1
* IMEI 2 where applicable
* Serial number
* Individual unit condition
* Individual unit status
* Manufacturer warranty information
* Individual acquisition cost
* Purchase association
* Sale association
* Return association
* Reclassification history
* Subsequent resale history

The system must prevent:

* Duplicate IMEI
* Duplicate serial number
* Selling the same serialized unit twice
* Selling an unavailable serialized unit
* Unauthorized unit-status manipulation

A serialized unit's identity must survive its entire lifecycle.

---

# 15. CAMERA SCANNING

### APPROVED MVP REQUIREMENT

Compatible mobile devices must support camera-based scanning where technically feasible.

Supported use cases include:

* Product barcodes
* Machine-readable IMEI codes
* Machine-readable serial-number codes

Camera scanning may be used during:

* Product lookup
* Inventory entry
* Serialized-unit registration
* Stock receiving
* Sales/POS
* Return processing
* Inventory lookup

Scanned information must pass the same:

* Validation
* Authorization
* Duplicate checking
* Inventory rules
* Serialized-unit rules
* Transaction checks

as manually entered information.

Manual entry must always remain available.

Manual entry is the fallback when:

* Camera access is unavailable
* The device/browser does not support scanning
* The label is damaged
* The identifier is plain text
* Recognition fails
* The user chooses manual entry

No paid scanning service may be introduced without Product Owner approval.

---

# 16. INVENTORY

Inventory is a core system function.

Inventory changes must originate from valid business transactions.

Approved inventory movement sources include:

* Purchases
* Completed sales
* Approved/processed returns
* Authorized inventory adjustments

Inventory must maintain an auditable movement history.

Inventory adjustments must record:

* Product/unit
* Quantity or state change
* User
* Reason
* Timestamp
* Relevant reference
* Audit information

Negative inventory is prohibited.

---

# 17. INVENTORY SOURCE OF TRUTH

PostgreSQL transactional records are the authoritative source of inventory information.

Client-side state must never be treated as authoritative inventory.

The system must protect against:

* Double sales
* Duplicate transactions
* Concurrent sales
* Invalid quantities
* Unauthorized adjustments
* Selling unavailable serialized units
* Selling the final unit to multiple employees simultaneously

---

# 18. INVENTORY COSTING

### APPROVED

For serialized products:

**Use the actual acquisition cost of the individual serialized unit.**

For non-serialized quantity-based products:

**Use weighted-average cost.**

Example:

10 units × ₦10,000 = ₦100,000
10 units × ₦12,000 = ₦120,000

Total:

20 units costing ₦220,000

Weighted-average cost:

₦11,000 per unit.

Historical sale cost must remain fixed after the sale.

A later inventory purchase at a different cost must not change historical profit calculations.

---

# 19. PURCHASES

The system must support recording inventory purchases.

Purchase records should include:

* Supplier
* Purchase date
* Reference/invoice information where applicable
* Product
* Variant
* Quantity
* Unit acquisition cost
* Total acquisition cost
* Serialized identifiers where applicable
* Responsible user

Purchases must correctly increase inventory.

Serialized purchases must allow:

* IMEI entry
* Serial-number entry
* Camera scanning
* Manual entry

Duplicate identifiers must be rejected.

---

# 20. SUPPLIERS

Supplier records must be maintained.

Relevant supplier information may include:

* Business name
* Contact person
* Phone
* Email
* Address
* Notes
* Purchase history
* Payment status
* Outstanding balance

The supplier module must remain operationally simple and must not become a full procurement or accounts-payable system.

---

# 21. SUPPLIER PAYMENTS

### APPROVED

The system will track basic supplier payment status.

Statuses:

* UNPAID
* PARTIALLY_PAID
* PAID

The system should track:

* Purchase total
* Amount paid
* Outstanding amount
* Payment status
* Payment history where needed
* Payment method
* User
* Timestamp

No complex accounts-payable functionality is required for MVP.

---

# 22. CUSTOMERS

Customer records support sales, returns and credit workflows.

Relevant information may include:

* Name
* Phone
* Email where available
* Address where genuinely required
* Purchase history
* Return history
* Credit history
* Outstanding credit balance

Do not collect unnecessary personal information.

---

# 23. CUSTOMER REQUIREMENT FOR SALES

### APPROVED

A registered customer is:

**OPTIONAL for ordinary sales.**

A customer record is mandatory for:

* Credit sales
* Return workflows
* Transactions requiring customer-specific credit/history

For serialized gadgets, attaching a customer to the sale is encouraged but is not mandatory unless another business rule requires it.

---

# 24. POINT OF SALE

The system must provide a practical POS workflow.

Core workflow:

Product selection
→ Cart
→ Customer where applicable
→ Discount where applicable
→ Payment
→ Confirmation
→ Sale completion
→ Receipt

The POS must work efficiently on both:

* Laptop
* Mobile

Serialized products must identify the specific unit being sold.

---

# 25. SALES

A completed sale must correctly record:

* Sale reference
* Items
* Quantities
* Serialized unit where applicable
* Selling prices
* Applicable approved discount
* Subtotal
* Total
* Customer where applicable
* Payment information
* User
* Timestamp
* Inventory effect
* Cost basis
* Relevant gross profit

The system must prevent partially committed sales.

---

# 26. SALE CALCULATIONS

The authoritative server/database layer must calculate or validate:

* Subtotal
* Discount
* Total
* Payments
* Outstanding balance
* Cost basis
* Gross profit

The browser must not be trusted to provide authoritative totals.

Example:

Product A: ₦100,000 × 2 = ₦200,000
Product B: ₦50,000 × 1 = ₦50,000

Subtotal:

₦250,000

Approved discount:

₦10,000

Final total:

₦240,000

The server must independently calculate or validate the result.

---

# 27. SPLIT PAYMENTS

### APPROVED

A single sale may use multiple payment methods.

Example:

Sale total: ₦1,000,000

Cash: ₦200,000
Bank Transfer: ₦500,000
POS: ₦300,000

Total paid:

₦1,000,000

The system must calculate the combined payment amount correctly.

Each component payment must record:

* Amount
* Payment method
* Confirming user
* Timestamp
* Sale reference

---

# 28. PAYMENT METHODS

Initial payment methods are:

* CASH
* POS
* BANK_TRANSFER
* OTHER

The system records:

* Amount
* Payment method
* Staff/user confirmation
* Timestamp
* Related transaction

MVP does not directly integrate with Nigerian banks.

The system records the responsible Staff member's payment confirmation.

---

# 29. PAYMENT INTEGRITY

The system must prevent:

* Negative payments
* Payments disconnected from transactions
* Manipulated totals
* Duplicate payment submissions
* Unauthorized payment modifications
* Invalid credit balances
* Silent overpayment corruption

Payment records must remain auditable.

---

# 30. DISCOUNTS

### APPROVED

Staff cannot independently grant discounts.

Staff may submit a discount request.

Manager may approve a discount only within the configured Manager maximum.

Admin controls the Manager discount limit.

Example:

Manager limit = 5%

Requested discount = 4%
→ Manager may approve.

Requested discount = 7%
→ Manager may not approve.

A discount beyond Manager authority requires Admin authority.

A user must not approve their own discount request.

Discount requests, approvals and rejections must be audited.

---

# 31. MANAGER DISCOUNT CONFIGURATION

Admin may change the Manager discount limit.

Changes must be:

* Authorized
* Validated
* Timestamped
* Audited

Manager and Staff cannot modify this setting.

---

# 32. CREDIT SALES

### APPROVED

Credit sales are exceptional rather than ordinary sales.

Credit approval authority belongs to:

* ADMIN
* MANAGER

Staff may prepare a sale and submit a credit request.

Workflow:

Staff creates sale
→ Credit requested
→ Manager/Admin reviews
→ Approved or rejected
→ If approved, sale completes as credit

Staff cannot independently approve credit.

---

# 33. CREDIT RECORDS

Credit transactions must track:

* Customer
* Sale
* Original amount
* Amount paid
* Outstanding balance
* Approval authority
* Payment history
* Payment method
* User
* Timestamp
* Status

Do not implement:

* Interest
* Penalties
* Automatic credit limits
* Mandatory repayment schedules

unless approved later.

---

# 34. CREDIT REPAYMENTS

After credit has been approved, repayments may be recorded by:

* ADMIN
* MANAGER
* STAFF

Every repayment must record:

* Customer/credit account
* Amount
* Payment method
* Recording/confirming employee
* Timestamp
* Remaining balance

A repayment must not cause an invalid negative balance.

---

# 35. RETURNS

### APPROVED

Customer returns are subject to:

**ADMIN REVIEW ONLY.**

Staff may submit return requests.

Manager cannot approve returns.

Admin decides whether to:

* APPROVE
* REJECT

A rejected return must not change inventory.

Return records must contain:

* Original sale
* Customer
* Product/unit
* IMEI/serial where applicable
* Return reason
* Condition at return
* Requesting Staff member
* Reviewing Admin
* Decision
* Decision timestamp
* Notes
* Resulting inventory classification
* Financial consequence
* Audit information

---

# 36. RETURN INVENTORY CLASSIFICATION

### APPROVED

A returned product must never automatically return to NEW inventory.

After Admin approves a return, the returned product must be classified based on the return reason and condition.

Approved post-return classifications:

* USED
* REFURBISHED

Required lifecycle:

NEW
→ SOLD
→ RETURN REQUESTED
→ ADMIN REVIEW
→ APPROVED
→ CONDITION ASSESSED
→ USED or REFURBISHED
→ INVENTORY

For serialized products:

* Preserve the original IMEI
* Preserve the original serial number
* Preserve acquisition history
* Preserve original condition
* Preserve original sale
* Preserve return information
* Record new condition
* Preserve subsequent resale history

Reclassification must be an auditable inventory event.

Historical records must never be rewritten to make it appear that the product was originally purchased or sold under its new classification.

---

# 37. RETURN FINANCIAL OUTCOME

### APPROVED

MVP supports these approved return outcomes:

* REFUND
* EXCHANGE

Store credit is not part of the MVP return process.

---

# 38. REFUNDS

### APPROVED

Admin may authorize:

* Full refund
* Partial refund

A refund must never exceed the amount actually paid by the customer for the relevant transaction/item.

A partial refund requires a recorded reason.

Refund records must include:

* Original sale
* Return
* Refund amount
* Full/partial status
* Reason where partial
* Approving Admin
* Payment method where applicable
* Timestamp
* Audit information

---

# 39. EXCHANGES

### APPROVED

The system supports exchanges.

If the replacement product costs more than the returned product:

**The customer pays the difference.**

Example:

Returned value: ₦500,000
Replacement product: ₦600,000

Customer pays:

₦100,000.

If the replacement product costs less:

The difference is recorded as a refund.

Example:

Returned value: ₦600,000
Replacement product: ₦500,000

Refund:

₦100,000.

All exchange-related financial and inventory effects must remain auditable.

The original sale and return history must remain intact.

---

# 40. WARRANTY

Manufacturer warranty must be maintained.

Relevant information may include:

* Manufacturer
* Warranty duration
* Warranty start date
* Warranty expiry date
* Terms/notes
* Product/unit
* IMEI/serial where applicable

Warranty information must remain associated with the product/unit through:

* Purchase
* Sale
* Return
* Reclassification
* Subsequent resale

The system must not silently destroy warranty history.

---

# 41. EXPENSES

Business expenses may be recorded by:

* ADMIN
* MANAGER

Staff cannot record expenses.

Relevant information includes:

* Category
* Amount
* Date
* Description
* Payment method
* Recording user
* Timestamp

Expense records must feed relevant financial reports correctly.

The expense module is not a full accounting system.

---

# 42. TAX / VAT

### APPROVED MVP RULE

The MVP will not implement a separate tax/VAT calculation engine.

Selling prices entered into TIMMERS GADGET are treated as the final retail selling prices for system transaction purposes.

Separate VAT calculation/reporting can be introduced later if explicitly required.

---

# 43. PROFIT

The system should calculate:

Revenue
− Cost of Goods Sold
= Gross Profit

And where applicable:

Gross Profit
− Operating Expenses
= Estimated Net Profit

For serialized products, cost of goods sold uses actual unit acquisition cost.

For non-serialized products, cost of goods sold uses weighted-average cost.

Historical profit must not change merely because current inventory prices later change.

---

# 44. REPORTING

Relevant reports include:

* Sales
* Purchases
* Inventory
* Inventory valuation
* Serialized-unit history
* Gross profit
* Expenses
* Estimated net profit
* Customer credit
* Supplier balances
* Returns
* Refunds
* Staff activity
* Low-stock products

Reports must derive from authoritative transaction data.

Reports must not rely on manually editable totals.

---

# 45. COMPLETED-SALE REVERSAL

### APPROVED

A completed sale cannot be deleted.

Only ADMIN can execute a completed-sale reversal.

Manager may identify/request correction but cannot perform the reversal.

Staff cannot reverse completed sales.

A sale reversal must:

* Require a reason
* Preserve the original sale
* Reverse applicable inventory effects
* Reverse applicable financial effects
* Preserve payment history
* Create appropriate reversal records
* Create an audit event

Historical records must not be rewritten to hide the original transaction.

---

# 46. HISTORICAL TRANSACTIONS

Completed business transactions should generally be append-oriented and auditable.

Do not casually delete or overwrite:

* Sales
* Payments
* Purchases
* Inventory movements
* Returns
* Refunds
* Exchanges
* Credit transactions
* Audit logs

Corrections should use controlled reversal/adjustment mechanisms.

---

# 47. AUDIT TRAIL

Important actions must be audited.

Audit-worthy events include:

* Sale creation/completion
* Sale reversal
* Payments
* Split payments
* Discounts
* Return requests
* Return approvals/rejections
* Return reclassification
* Refunds
* Exchanges
* Inventory adjustments
* Purchases
* Supplier payments
* Credit approvals
* Credit repayments
* Staff changes
* Permission changes
* Business setting changes
* Manager discount-limit changes

Audit information should contain where applicable:

* Actor
* Action
* Entity type
* Entity ID
* Timestamp
* Relevant metadata
* Before value
* After value
* Transaction reference

Normal application users cannot modify or delete audit history.

---

# 48. DATA INTEGRITY

Use PostgreSQL database controls where appropriate:

* Foreign keys
* Unique constraints
* Check constraints
* Indexes
* Transactions
* Row Level Security
* Server-side validation

Business-critical integrity must not rely solely on client-side validation.

---

# 49. TRANSACTION ATOMICITY

Critical operations must be atomic.

Examples include:

* Sale completion
* Purchase completion
* Return processing
* Refund processing
* Exchange processing
* Inventory adjustments
* Credit repayments

If a critical operation fails, the system must not leave partially committed business data.

---

# 50. CONCURRENCY

The application must support simultaneous use by multiple employees.

Examples:

Two employees attempt to sell the final unit.

Expected:

Only one succeeds.

Two employees attempt to sell the same IMEI.

Expected:

Only one succeeds.

Two users attempt to approve the same discount.

Expected:

Only one valid approval is recorded.

Database-level transaction protection must be used where appropriate.

---

# 51. DUPLICATE SUBMISSION

Critical actions must be protected against accidental repeated submission.

Including:

* Complete Sale
* Record Payment
* Complete Purchase
* Approve Discount
* Approve Return
* Process Return
* Refund
* Exchange
* Credit repayment
* Inventory adjustment

Rapid double-clicks and network retries must not create duplicate business transactions.

---

# 52. SERVER CONNECTIVITY / OFFLINE BEHAVIOUR

The application may cache safe application resources as part of its PWA functionality.

However, during MVP:

**Critical stock-affecting transactions require authoritative server connectivity.**

The system must not finalize fully offline:

* Sales
* Purchases
* Returns
* Inventory adjustments
* Other critical stock mutations

This avoids conflicting inventory transactions across devices.

---

# 53. MOBILE REQUIREMENTS

Mobile is a first-class platform.

Core mobile workflows include:

* Login
* Product search
* Camera scanning
* Serialized-unit lookup
* Sales/POS
* Customer selection
* Payment
* Receipt
* Inventory lookup
* Return request
* Appropriate approvals

The mobile UI must not simply be a compressed desktop screen.

---

# 54. LAPTOP / DESKTOP REQUIREMENTS

The desktop/laptop interface should efficiently support:

* Dashboard
* POS
* Inventory
* Tables
* Purchases
* Customers
* Suppliers
* Expenses
* Returns
* Credit
* Reports
* Staff administration
* Audit logs
* Settings

---

# 55. SECURITY

Security requirements include:

* Supabase Auth
* Role-based authorization
* PostgreSQL Row Level Security
* Server-side business validation
* Database constraints
* Protected secrets
* Protected service credentials
* Auditability
* Transaction integrity
* Privilege-escalation protection
* Client-side financial manipulation protection

Security must not rely solely on hiding buttons.

---

# 56. TECHNOLOGY ARCHITECTURE

Approved baseline:

Frontend:

* Next.js
* React
* TypeScript

UI:

* Tailwind CSS
* Accessible reusable components

Backend platform:

* Supabase

Database:

* PostgreSQL

Authentication:

* Supabase Auth

Authorization:

* Application permissions
* PostgreSQL RLS

Hosting:

* CLOUDFLARE

Version control:

* Git
* GitHub

Application type:

* Responsive PWA

Cloudflare is the approved hosting/deployment platform.

Do not replace Cloudflare with Vercel or another hosting provider without Product Owner approval.

---

# 57. COST CONTROL

The system should remain as close to free as reasonably possible.

Prefer:

* Free tiers
* Open-source software
* Existing infrastructure
* No unnecessary subscriptions

Any paid service requires Product Owner approval.

This includes paid services for:

* Hosting
* Database
* Camera scanning
* SMS
* Email
* Monitoring
* Payment integration
* Storage
* Other third-party infrastructure

---

# 58. OUT OF SCOPE FOR MVP

The following are not part of the initial MVP:

* Repairs
* Multi-branch management
* Payroll
* HR management
* Staff commissions
* Customer-facing online storefront
* Full e-commerce
* Full accounting/ERP replacement
* Native Android application
* Native iOS application
* AI functionality
* Automated bank integration/reconciliation
* Complex accounts payable
* Credit interest
* Credit penalties
* Automated credit limits
* Store-credit return system
* Separate VAT/tax engine
* Other major features not explicitly approved

---

# 59. TESTING REQUIREMENTS

Critical workflows must be tested.

Required areas include:

* Authentication
* Authorization
* Products
* Product conditions
* Inventory
* Serialized inventory
* Camera scanning
* Manual scanning fallback
* Purchases
* Supplier balances
* Customers
* POS
* Sales
* Split payments
* Discounts
* Credit
* Credit repayments
* Returns
* USED/REFURBISHED reclassification
* Refunds
* Exchanges
* Expenses
* Reports
* Sale reversal
* Audit logs
* Concurrency
* Duplicate submissions
* Security
* PWA/mobile functionality

---

# 60. ADVERSARIAL TESTING

Test invalid or malicious cases including:

* Negative quantities
* Negative prices
* Duplicate IMEI
* Duplicate serial
* Invalid IDs
* Manipulated totals
* Manipulated discounts
* Unauthorized API requests
* Unauthorized role operations
* Repeated submissions
* Concurrent transactions
* Invalid state transitions
* Attempt to resell sold serialized unit
* Attempt to classify returned product as NEW
* Attempt to bypass Admin return approval
* Attempt to exceed Manager discount limit
* Attempt to refund more than customer paid
* Attempt to bypass camera-scan validation
* Attempt to create Staff-authorized credit
* Attempt to reverse completed sale as Manager/Staff

---

# 61. DEFINITION OF DONE

A feature is complete only when:

* UI works
* Mobile works
* Desktop works
* Database integration works
* Server logic works
* Authorization works
* Validation works
* Business rules work
* Error handling works
* Relevant audit logging works
* Relevant tests pass
* Production build passes
* No known critical defect remains

A mock screen, placeholder, hardcoded result or unconnected button is not considered implementation.

---

# 62. APPROVED / PROPOSED / DECISION REQUIRED

All project decisions should be classified as:

### APPROVED

Explicit Product Owner-approved requirement.

### PROPOSED

Recommendation only.

### DECISION REQUIRED

A material business or architectural decision requiring Product Owner input.

### OUT OF SCOPE

Explicitly excluded from MVP.

Codex and developers must never silently turn a PROPOSED requirement into an APPROVED requirement.

---

# 63. PRODUCT OWNER AUTHORITY

The Product Owner has final authority.

No implementation agent or developer may independently change:

* Business rules
* Financial rules
* Inventory rules
* Costing method
* Return policy
* Refund policy
* Exchange policy
* Discount authority
* Roles
* Permissions
* Credit policy
* Payment behaviour
* Tax policy
* Hosting provider
* Major architecture
* MVP scope

without explicit approval.

---

# 64. INITIAL DEVELOPMENT ORDER

Recommended implementation sequence:

1. Repository/project foundation
2. Database architecture
3. Authentication
4. Roles/permissions
5. RLS/security
6. Products/categories/brands
7. Product conditions
8. Inventory
9. Serialized inventory
10. Camera scanning
11. Suppliers
12. Purchases
13. Supplier payment tracking
14. Customers
15. POS
16. Sales
17. Payments/split payments
18. Discount workflow
19. Credit workflow
20. Returns
21. Return reclassification
22. Refunds/exchanges
23. Expenses
24. Reports
25. Sale reversal
26. Staff management
27. Audit logs/settings
28. Security hardening
29. Full-system testing
30. PWA/mobile validation
31. Cloudflare deployment preparation
32. Production deployment

---

# 65. FINAL PRODUCT PRINCIPLE

TIMMERS GADGET must be built as a real operational business system.

Priority:

**Correctness > Security > Reliability > Usability > Performance > Visual polish**

The system must be simple enough for daily Staff use, strict enough to protect inventory and money, and reliable enough to become the shop's primary operational record.

When a technical decision is routine, engineering may decide it.

When a business decision is unclear, it must be returned to the Product Owner.

When something is outside the approved MVP scope, it must not be silently introduced.