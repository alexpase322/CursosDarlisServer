const express = require('express');
const router = express.Router();
const { createCourse, getAllCourses, getCourse, updateCourse, deleteCourse, addLesson, addModule, deleteLesson, deleteModule, addResource, deleteResource} = require('../controllers/courseController');
const { protect, admin } = require('../middleware/authMiddleware');
const multer = require('multer');

const upload = multer({ dest: 'uploads/' });

router.route('/')
    .get(protect, getAllCourses)
    .post(protect, admin, upload.single('thumbnail'), createCourse);

// Rutas específicas por ID (GET, PUT, DELETE)
router.route('/:id')
    .get(protect, getCourse)
    .put(protect, admin, upload.single('thumbnail'), updateCourse)
    .delete(protect, admin, deleteCourse);

router.route('/:id/modules')
    .post(protect, admin, addModule);

// Rutas para Lecciones (requiere ID del curso y ID del módulo)
router.route('/:id/modules/:moduleId/lessons')
    .post(protect, admin, addLesson);

router.route('/:id/modules/:moduleId')
    .delete(protect, admin, deleteModule); // <--- NUEVO

// Modifica esta sección para incluir DELETE en lecciones
router.route('/:id/modules/:moduleId/lessons/:lessonId')
    .delete(protect, admin, deleteLesson); // <--- NUEVO

router.route('/:id/modules/:moduleId/lessons/:lessonId/resources')
    .post(protect, admin, addResource);

router.route('/:id/modules/:moduleId/lessons/:lessonId/resources/:resourceId')
    .delete(protect, admin, deleteResource);

module.exports = router;