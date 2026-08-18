const express = require('express');
const router = express.Router();
const { createCourse, getAllCourses, getContentVault, getCourse, updateCourse, deleteCourse, addLesson, addModule, deleteLesson, deleteModule, addResource, deleteResource} = require('../controllers/courseController');
const { protect, admin } = require('../middleware/authMiddleware');
const { singleImage } = require('../config/upload');

router.route('/')
    .get(protect, getAllCourses)
    .post(protect, admin, singleImage('thumbnail'), createCourse);

// Baúl de contenido. DEBE ir antes de '/:id', si no Express interpreta
// "vault" como un id de curso y devuelve 404.
router.get('/vault', protect, getContentVault);

// Rutas específicas por ID (GET, PUT, DELETE)
router.route('/:id')
    .get(protect, getCourse)
    .put(protect, admin, singleImage('thumbnail'), updateCourse)
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